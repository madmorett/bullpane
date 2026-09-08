# Architecture

Bullpane is a self-hosted dashboard for BullMQ and BullMQ Pro. It follows the
Metabase model: a free edition that does everything the open-source dashboards do, and a
Pro subscription (USD 19/month or 149/year, one installation) that unlocks team features.

```
bullpane/
├── apps/
│   ├── server/          Fastify API + serves the built web UI. Owns MySQL, auth, alerts, licensing.
│   ├── web/             React + Vite dashboard.
│   └── simulator/       Generates realistic BullMQ (and fake Pro group) traffic for the live demo.
├── packages/
│   ├── shared/          Types + zod schemas shared by everything. THE contract.
│   └── redis-inspector/ ioredis + Lua scripts. All reads of a customer's Redis go through here.
├── scripts/gen-license.ts   Ed25519 keypair + offline license signing (vendor side).
├── apps/license-api/        Cloudflare Worker at api.bullpane.com: activates subscription
│                            keys at the store (Creem) and signs 7-day leases.
├── Dockerfile               Multi-stage: build web + server, run one node process.
├── docker-compose.yml       app + mysql (bring your own Redis).
└── docker-compose.demo.yml  app + mysql + redis + simulator, DEMO_MODE=true.
```

## Data flow

```
Browser ──HTTP/JSON──> Fastify (apps/server)
                         │  auth (cookie session) · role check · pro-feature gate
                         ├──> MySQL (users, sessions, connections, folders, alerts, flow edges, settings)
                         └──> InspectorPool (packages/redis-inspector)
                                └──> ioredis per connection ──EVALSHA──> customer Redis
```

* The server never touches Redis directly. Everything goes through `Inspector`
  (`packages/redis-inspector/src/types.ts`).
* The inspector never touches MySQL. It is stateless apart from connection caches.
* The web UI only talks to `/api/*`. It polls; there is no websocket in v1
  (polling with a Lua-backed counts endpoint is one EVALSHA per queue, cheap enough).

## Performance contract (why the inspector exists)

Customers point this at production Redis. A dashboard that hurts the workload is worse than
no dashboard. Rules, enforced in `redis-inspector`:

1. **No `KEYS`, ever.** Discovery is `SCAN ... MATCH prefix:*:meta COUNT 1000`, **incremental**:
   a pass spends at most `maxScanIterations` / `discoveryScanBudgetMs` and keeps its cursor, so a
   keyspace of millions of keys is covered over a few passes instead of silently giving up
   (the old fixed 200 × 500 budget returned zero queues on a 1.3M-key Redis). Queues with a
   connected worker are found immediately through `CLIENT LIST` names, known names are
   re-verified with `EXISTS` every pass, and `discoveryStatus()` tells the UI whether a full
   cycle has completed. Cached for `discoveryTtlMs` (30 s); a full re-scan every 5 min.
1b. **Payload size never sets the cost of a page.** `HMGET data` copies the whole field into
   Lua before it can be truncated, so list reads check `HSTRLEN` first and skip fields above
   `listFieldCapBytes` (32 KiB; the row carries `dataBytes` instead). Search skips `data`
   above `searchFieldCapBytes` (256 KiB) and stops a call at `searchByteBudget` (8 MiB),
   handing back the cursor. Measured on 1 MB payloads: a 200-job page went from 290 ms to
   single-digit ms of Redis time; a search call from 13 s to milliseconds.
2. **One round trip per read.** Counts, pages and details are Lua scripts registered with
   `defineCommand` (EVALSHA). Multi-queue reads are a single pipeline.
3. **Truncate inside Redis.** List views return `string.sub(data, 1, previewBytes)`.
   A queue full of 500 KB payloads costs the same to render as a queue of tiny ones.
4. **Search is bounded and resumable.** Substring search runs in Lua over at most
   `maxScanPerCall` job hashes per call and hands back a cursor. The UI streams results in.
5. **Writes use the official bullmq library.** We do not reimplement retry/promote/remove;
   we inherit BullMQ's atomic scripts and stay correct across versions.
6. **Cluster safe.** Each script touches keys of exactly one queue (same hash tag).
7. **Connections fail fast.** `connectTimeout 5 s`, `maxRetriesPerRequest 1`,
   `enableOfflineQueue false`. A dead Redis produces a red badge, not a hung dashboard.

## How alerts measure (and what they refuse to measure)

`waiting_above` is a **gauge**: `counts.waiting + counts.prioritized`, read from the
state keys. `paused` is deliberately excluded — pausing a queue for maintenance moves
every waiting job into the `paused` list, and counting it made the correct operational
move fire a backlog alert.

`failed_above` and `failed_rate_above` are **rates**, and they come only from BullMQ's
own cumulative metrics counters (`${prefix}:${queue}:metrics:completed|failed`, field
`count`), read by `Inspector.getMetricsCounters` (two `HGET`s, one pipeline, one round
trip, single-slot). The engine samples them each tick and diffs the newest sample
against the oldest one still inside the alert's `windowMinutes`
(`apps/server/src/alerts/metricsWindow.ts`).

`ZCOUNT` over the `completed`/`failed` sorted sets — what this used to do — counts only
jobs still present in Redis, so any queue using `removeOnComplete` reports a wildly
inflated failure rate. Measured on a real Redis: 300 ok / 15 failed (4.8%) reads as
50 ok / 15 failed (23.1%). **There is no fallback on purpose.** A queue whose Worker was
not created with `metrics: { maxDataPoints }` gets no error alert; the alert reports
`measurement.state = "no_metrics"`, records one informative `AlertEvent` per cooldown,
and never fires. An absent alert is a known gap; a lying alert costs trust in every
other alert.

Consequences worth knowing:

* The counter history is in memory, so a restart means `warming_up` (accumulating
  history) for one window — never "zero failures".
* A counter that goes backwards (Redis restarted, queue obliterated) restarts the
  series rather than reporting a negative delta.
* `getWindowCounts` (ZCOUNT) is retained for panel-side reads, where `retentionSkewed`
  labels it as unreliable. It must not come back into alerting.

## Getting from the number to the jobs (deep links + bulk actions)

Two symptoms of the same gap: the product let you *see* the problem clearly and
not *fix* it.

**Every entry point used to throw away the state.** The cards, the table rows
and the sidebar all called `routes.queue(cid, name)` with no `state`, and the
queue page defaults to `waiting`. So clicking a queue showing 1.000 failures
opened an empty table saying "No jobs in this state" — a wasted click in 100% of
incidents. The fix is one pure function, `apps/web/src/lib/queueLanding.ts`:
`failed > 0` → `failed`, else `waiting > 0` → `waiting`, else `prioritized` if
that is where the jobs are, else `completed` (the only tab with content on an
idle queue). Every entry point calls it, and the individual count chips and
table numbers are links to *their own* state.

The queue card is covered by a stretched link overlay
(`after:absolute after:inset-0` on the queue name), which made the chips
structurally unclickable. `StateChip` with a `to` prop renders as a `<Link>`
with `relative z-10`, so it sits above that overlay in the same stacking
context — the trick the card's search icon already used. A click anywhere else
still hits the overlay and goes to the landing state. In the sidebar the failed
pill stays a `<span>`: it is already inside a `NavLink`, and a link inside a link
is invalid HTML — the row itself already lands on `failed`.

**Between "one job" and "all 1.000" there was nothing**, and the middle is the
real case: failures arrive clustered (one tenant's webhook answering `HTTP 410`),
the bounded server-side search finds exactly those 50, and the operator wants to
retry those and drop the others. `Inspector.bulkJobAction(queue, action, jobIds)`
plus three `operator` routes fill it. See docs/API.md for the contract; the two
decisions that shape it are the **explicit 500-id ceiling** validated in zod
(without it someone pastes 100k ids and pins the customer's Redis) and
**partial results with 200** — an id may have been pruned between the listing
and the click, and aborting on the first error would hide the 47 that worked.
Concurrency is capped at 8, not `Promise.all` over 500.

On the web side the selection is keyed by **jobId, never by index**
(`apps/web/src/lib/useJobSelection.ts`). The table repolls every 3 s and rows
change position — that is already the cause of mis-clicks today, and a stored
index would point at a different job on the next tick. Selected ids that scroll
out of the visible page stay selected and are reported ("3 selected (2 not on
this page)") rather than dropped silently; with a search on screen the bar says
the selection came from the loaded search results, not the whole state. Bulk
remove always confirms with the count and the queue name, and the single-job
remove now confirms too.

## Stalled is not a state, and the dashboard says so

Verified against bullmq 5.81.4 on a live Redis: `stalled` is an auxiliary SET at
`${prefix}:${queue}:stalled`, `getState()` on a stalled job returns `active`,
and `stalled` is not in `JOB_STATES`. A stalled job is an `active` job whose
worker died without renewing its lock.

So there is deliberately **no "stalled" tab** — it would lie about BullMQ's
model. What there is instead:

* `QueueSummary.stalledCount`, a `SCARD` folded into the existing `queueStats`
  script. One extra O(1) command inside the same EVALSHA, no extra round trip,
  and it lives outside `counts` so it never pads a total made of jobs that are
  already counted as `active`. It drives a warning on the `active` tab:
  "N of these are stalled (worker lost the lock)". Before it, an operator saw
  "active 8" with no way to know 3 of them were dead.
* `JobSummary.stalledCounter` (`stc` on the hash, `HINCRBY`ed by
  `moveStalledJobsToWait-9.lua`), shown as a badge on the row when `> 0`. It is
  the durable trace and the only honest answer to "why did this job run twice?".

The check runs in two passes: one marks every `active` id into the SET, the next
moves the lock-less ones back to `wait`, bumps `stc` and `DEL`s the SET. So the
count is a transient reading and the counter is the permanent one — which is
also how the integration test pins it down, by calling
`Worker.moveStalledJobsToWait()` directly instead of racing a timer.

## Hiding a queue vs obliterating it

Two adjacent actions with opposite stakes, so they are kept visibly different:

| | Hide | Obliterate |
|---|---|---|
| Redis | untouched | every key of the queue deleted |
| Jobs | all kept | all gone |
| Workers / alerts | keep running, keep measuring | nothing left to measure |
| Reversible | yes, one click | no |
| Guard | none — a toast with Undo | type-the-queue-name confirmation |
| Role | operator | admin |

Hiding is a row in `hidden_queues` (`connection_id`, `queue_name`, `hidden_at`, `hidden_by`),
scoped to the **instance** and not to the user: a queue a lead declares dead is dead for the
whole team, and a dashboard that differs per person is a liability mid-incident.

The filter lives in `ConnectionsService.listQueues` — the service layer — and never in
`Inspector.discoverQueues`. The inspector is stateless and must not learn about MySQL, and
more importantly a hidden queue has to stay *measurable and reachable*: the alerts engine
talks to the inspector directly (hiding never silences an alert), and
`/connections/:id/queues/:queue` plus every sub-route is untouched, so a bookmark or an
alert link still opens the queue with a "this queue is hidden" banner and a reveal button.
Aggregate strips sum only visible queues and print `N hidden` beside the total. See
docs/API.md, "Hidden queues".

## Editions

| Capability | Free | Pro (USD 19/mo or 149/yr) |
|---|---|---|
| Unlimited connections & queues | ✓ | ✓ |
| Job list / detail / search in data | ✓ | ✓ |
| Add · retry · promote · remove · clean · drain · pause | ✓ | ✓ |
| Bulk retry / promote / remove on a selection (incl. search results) | ✓ | ✓ |
| BullMQ Pro groups & batches view | ✓ | ✓ |
| Single admin login | ✓ | ✓ |
| Alerts per queue or per folder (waiting, failures, failure %) → Slack / webhook | – | ✓ |
| Users & roles (admin / operator / viewer) | – | ✓ |
| Folders to organise queues (default: one per connection) | – | ✓ |
| Flow graph (detected from BullMQ flows + manual edges) | – | ✓ |
| Audit log: who did what to which queue, persisted + CSV export | – | ✓ |
| SSO: OIDC + SAML 2.0, configured by the customer's admin in the UI | – | ✓ |

Gating is one function on the server (`requireFeature(feature)`) returning HTTP 402
`{ error: "pro_required", feature }`, and one hook on the web (`useEdition()`), so the UI
shows the locked feature with a lock icon and an upsell instead of hiding it.

## SSO: the IdP proves identity, it does not create accounts

Configured **in the UI**, not through env vars (`sso_providers` in MySQL, one row per
provider, `config` as JSON). A self-hosted install has no vendor to file a ticket with:
if a wrong issuer URL could only be fixed by editing a compose file and redeploying,
the feature would be a liability. `Settings → SSO` also prints the two values the
admin has to paste at the IdP (redirect URI, or ACS URL + entity ID) and a **Test**
button that resolves OIDC discovery without performing a login.

**There is deliberately no just-in-time provisioning.** The callback resolves the
asserted email against an existing `users` row and refuses when there is none — the
person gets "ask an admin to add you under Users & roles", and the admin gets an
`auth.sso_denied` audit row naming the email, which is how they learn who to invite.
JIT would silently turn "anybody with a Google account" into "anybody with a Bullpane
login", on a dashboard that sits on production queues. Role assignment stays a human
decision. An admin can now create a **password-less account** (`password` omitted →
NULL `password_hash`), so an SSO user has no dormant credential; `verifyPassword`
refuses a NULL hash outright, so such an account cannot use the password form at all.

**The escape hatch is the reason "require SSO" is safe to ship.** The toggle hides the
password form, but admins keep password access, and `BULLPANE_ALLOW_PASSWORD_LOGIN=true`
widens that to everyone. Without a way back in, one misconfigured IdP locks a customer
out of their own installation permanently. The check runs *after* the password is
verified, so it cannot be used to enumerate accounts or roles. Deleting the last
enabled provider while the toggle is on is refused, and turning the toggle on with no
enabled provider is refused.

**What is validated, and why each one is load-bearing.** OIDC is hand-rolled (three
fetches and one signature check; `openid-client` would be a dependency tree in a binary
customers audit) with PKCE always on: signature against the JWKS key named by `kid`,
`iss` equals the *discovered* issuer, `aud`/`azp` contains our client id (without it, a
token minted for a different app at the same IdP logs somebody in here), `nonce` equals
the one in the signed flow cookie, `exp`/`iat` within 120 s. `alg: none` and HMAC are
refused before any key lookup. SAML uses `@node-saml/node-saml` — signed XML means
canonicalisation and signature-wrapping defences, which is how CVEs happen when
hand-rolled — with `wantAssertionsSigned`, the audience pinned to our entity id, and
`validateInResponseTo: always` against a TTL- and size-bounded cache (the replay
defence, equivalent to OIDC's nonce).

**Flow state lives in a signed, single-use cookie**, not in server memory: an install
behind two replicas would otherwise fail every other login, and an in-memory map is a
leak an anonymous caller can drive. `?next` is validated to a local path — an open
redirect in a login flow is a phishing primitive. Failures redirect to
`/login?sso_error=<one sentence>`, because the user is in a browser mid-redirect and a
JSON 500 is not an answer.

**Client secrets are encrypted, not hashed** (AES-256-GCM, key derived via HKDF from
`SESSION_SECRET`): an OIDC secret must be replayed to the token endpoint, so it has to
be recoverable. A MySQL dump therefore does not yield the customer's IdP credentials.
It never comes back out of the API — `SsoProvider.hasSecret` is all the UI learns. The
operator consequence: **rotating `SESSION_SECRET` makes stored secrets undecryptable**,
and the error says so and tells the admin to re-enter it. SAML needs no secret; it
verifies a signature with a public cert.

**Two places the SSO login flow bends an existing rule, both on purpose.** The OIDC
callback is a `GET` that authenticates somebody, so it is the single exception to
"reads are never audited" (`AUDITED_READS` in `plugins/audit.ts`) — otherwise the trail
would record password logins but not SSO ones, and its contents would depend on which
protocol the customer chose. And the SAML callback is a `POST`, so read-only mode
allows that one path (`isLoginWrite`): read-only is about not touching the customer's
queues, and it was never meant to stop people signing in. The admin CRUD under
`/api/sso/*` stays blocked, because that is a configuration write.

Two kinds of key, one verifier. Both are `base64url(payload).base64url(signature)`
signed with the vendor Ed25519 key whose public half is compiled into the server:

* **Subscription key** (sold on bullpane.com through Creem). Pasting it
  makes the server call the license API (`apps/license-api`, api.bullpane.com), which
  activates the key at the store — activation limit 1, so a key works on exactly one
  installation — and answers with a **7-day signed lease**. The server refreshes the
  lease every `BULLPANE_LICENSE_REFRESH_HOURS` (24). No answer keeps the lease and shows
  "grace"; a definitive answer (cancelled, expired, used elsewhere) locks Pro at once.
  Removing the key releases the activation so it can be used on another server.
* **Offline key**, hand-signed with `scripts/gen-license.ts` for customers who cannot
  phone home. Perpetual or dated, never contacts anything.

The dashboard never talks to the store directly and only ever sends the key, an
instance label (hostname + PUBLIC_URL) and the activation id. Details: docs/PRO.md.
`DEMO_MODE=true` unlocks Pro with a "demo" badge and blocks destructive settings
changes so the public playground can't be broken.

## Roles

| Action | viewer | operator | admin |
|---|---|---|---|
| View queues, jobs, alerts, flows | ✓ | ✓ | ✓ |
| Add / retry / promote / remove jobs, pause / resume, clean, create alerts, manual flow edges, folders, hide / unhide a queue | – | ✓ | ✓ |
| Drain / obliterate queue, manage connections, users, license | – | – | ✓ |
| Read / export the audit log | – | – | ✓ |

In the free edition there is exactly one user (admin). Inviting more is a Pro feature.

## Flow detection

BullMQ flow children carry a `parent` field (`{ id, queueKey }`) in their job hash.
`sampleFlowEdges` reads the newest N jobs across states and aggregates `parent.queueKey`.
That yields `child → parent` edges with evidence counts at the cost of N `HMGET`s per queue
per refresh, bounded and cached. Plain "worker of A calls B.add()" cannot be observed from
Redis without instrumenting the producer, so those edges are drawn manually and stored in
MySQL. Both kinds render on the same graph, styled differently.

## BullMQ Pro

Pro queues share the standard key layout and add group keys under `${prefix}:${queue}:groups*`.
The layout is documented in `packages/redis-inspector/src/keys.ts` (`GROUP_KEY`), verified
against `@taskforcesh/bullmq-pro` 7.48.0. The facts that shape the reader:

- A group sits in exactly one of four status zsets: `groups` (waiting), `groups:limit`,
  `groups:max`, `groups:paused`. "All groups" is their union, paged in that order — a queue
  whose groups are all maxed has **no** `groups` key, so Pro detection looks at all four
  (plus `groups:metas` and `meta.version`).
- Per-group settings live in `groups:${gid}:meta` (`conc`, `lm`, `ld`) and only take effect
  when the worker runs with `group.concurrency` / `group.limit`; `groups:active:count` is only
  maintained in that case. The UI says "worker default" when no override exists instead of
  guessing a number.
- `groups:${gid}:meta` matches the discovery pattern `*:meta`; discovery drops those names.

Reads are read-only, one EVALSHA per page (`getGroups.lua`). The simulator writes the same
layout so the demo shows groups without needing a Pro token.

## Audit log (Pro)

The differentiator: bull-board has no users at all, so it cannot say who did anything;
Taskforce is hosted, so the answer lives in someone else's account. A company with a
regulated customer needs to know who touched the production queue, from its own database.

The trail already existed as pino lines (`{ queue, jobId, by }`) in every mutating
handler. That is a debugging aid, not an audit trail: it dies with the container and
nobody queries it. `audit_log` is the same information, persisted, filterable, exportable.

### Instrumentation: one hook, enriched by handlers

`plugins/audit.ts` registers a single `onResponse` hook for the whole `/api` tree, next to
`blockWrites` in `routes/index.ts` and for the same reason. The failure mode of a call per
handler is silent: a route added in six months without its `audit.record(...)` line leaves
a hole nobody notices until an auditor asks. A hook cannot be forgotten — an unmapped
mutating route logs a warning the first time it is called. The action comes from
`method + request.routeOptions.url`, the route PATTERN, so a queue literally named `pause`
cannot fake a match and the map holds one entry per route instead of one per queue name.

A hook alone cannot see "3,412 jobs were cleaned", so handlers enrich the pending row via
`request.auditDetail(...)` / `request.auditTarget(...)`. Coverage is the hook's job;
richness is the handler's. Only mutating methods are recorded: the UI polls `/queues`
every 5 s per connection, so auditing reads would bury the rows that matter.

### Two design rules

1. **The actor is denormalised** (`actor_email`, `actor_name`, `actor_role`), and so is
   the connection name. There is no FK to `users` or `connections`. A trail whose only
   pointer to the person is a foreign key stops meaning anything the day that user is
   deleted — and that is the normal audit case, not the edge case. `GET /audit/actors`
   reads distinct actors out of the log itself so deleted people stay filterable.
2. **`detail` never holds a job payload.** It carries the parameters of the action; the
   payload routinely holds customer PII and this table is exportable as CSV.
   `sanitizeDetail` strips `data`/`payload`/`body`/`returnvalue` and credential-shaped
   keys at any depth, so the CLAUDE.md rule ("never log job data") is enforced in one
   place rather than in every future handler. Where the size is useful it is recorded as
   `dataBytes`.

Two more consequences worth knowing:

* `record()` **never throws.** A failing insert is logged and the request proceeds: a gap
  in the trail beats a 500 for the operator resuming the payments queue at 3 a.m. The
  opposite posture (refuse the action when it cannot be recorded) is a one-line change in
  `AuditService.record`, and it is a product decision, not an oversight.
* **Failed actions are recorded** (`result: "error"`, with the mapped API error). "Tried
  to obliterate and got a 403" is a finding; a success-only log would show silence.
  `auth.login_failed` is its own action for the same reason, and it deliberately does not
  record whether the email exists, so the log is not an account-enumeration oracle.

### Why Pro and not Free

Audit is gated as Pro, and the argument is that it is *only meaningful with more than one
person*. On a single-admin install — the free edition has exactly one user — every row
says "it was me", which is a diary, not an audit trail. The value appears the moment there
are several logins with different roles, and that is already Pro (`users`). Anyone who
needs to answer "who paused this?" has a team by definition, and a team on a USD 19/month
licence is not a hard sell.

The counter-argument is real: a solo operator with a regulated customer may need the trail
for an external auditor even with one login. Two things blunt it. First, gating does not
stop the recording — the hook writes rows in every edition; only reading and exporting are
gated, so upgrading later reveals history that was already captured instead of starting
from zero. Second, the page is shown locked with the upsell rather than hidden, so the
capability is discoverable exactly when someone needs it.

Retention is `BULLPANE_AUDIT_RETENTION_DAYS` (default 365, `0` = forever), pruned once a day on
its own timer rather than on the alerts tick — that tick returns early unless alerts are
unlocked, which would let rows grow forever after a licence lapsed. Roughly 350-600 bytes
per row including indexes; a dashboard humans click writes a few hundred rows a day
(~40 MB/year), a script-driven instance at 10k mutating calls/day about 2 GB/year.
