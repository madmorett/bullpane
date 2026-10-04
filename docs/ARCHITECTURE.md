# Architecture

Bullpane is a self-hosted dashboard for BullMQ and BullMQ Pro. It follows the
Metabase model: a free edition that does everything the open-source dashboards do, and a
Pro subscription (USD 39/month or 390/year, one installation) that unlocks team features.

```
bullpane/
├── apps/
│   ├── server/          Fastify API + serves the built web UI. Owns the database, auth, alerts, licensing.
│   │   └── src/ee/      Pro features (alerts, audit, folders, flows, SSO, user admin). Commercial license.
│   ├── web/             React + Vite dashboard.
│   │   └── src/ee/      Pro pages. Commercial license.
│   └── simulator/       Generates realistic BullMQ (and fake Pro group) traffic for the live demo.
├── packages/
│   ├── shared/          Types + zod schemas shared by everything. THE contract.
│   ├── inspector/       The backend-neutral `Inspector` interface the server codes against.
│   ├── redis-inspector/ ioredis + Lua scripts. All reads of a customer's Redis go through here.
│   └── pg-inspector/    SQL over BullMQ 6's Postgres schema. All reads of a customer's Postgres go here.
├── scripts/gen-license.ts   Ed25519 keypair + offline license signing (vendor side).
├── apps/license-api/        Cloudflare Worker at api.bullpane.com: activates subscription
│                            keys at the store (Creem) and signs 7-day leases.
├── Dockerfile               Multi-stage: build web + server, run one node process.
├── docker-compose.yml       app on SQLite; COMPOSE_PROFILES=mysql adds MySQL (bring your own Redis).
└── docker-compose.demo.yml  app + mysql + redis + simulator, DEMO_MODE=true.
```

## Data flow

```
Browser ──HTTP/JSON──> Fastify (apps/server)
                         │  auth (cookie session) · role check · pro-feature gate
                         ├──> SQLite or MySQL (users, sessions, connections, folders, alerts, flow edges, settings)
                         └──> InspectorPool (apps/server/src/services/inspectorPool.ts)
                                ├──> RedisInspector: ioredis per connection ──EVALSHA──> customer Redis
                                └──> PgInspector: pg pool per connection ──SQL──> customer Postgres (BullMQ 6)
```

* The server never touches Redis or Postgres directly. Everything goes through
  `Inspector` (`packages/inspector/src/types.ts`); a connection's `kind` picks
  the implementation, and nothing above the pool knows which one it got.
* The inspector never touches the database. It is stateless apart from connection caches.
* The web UI only talks to `/api/*`. It polls; there is no websocket in v1
  (polling with a Lua-backed counts endpoint is one EVALSHA per queue, cheap enough).

## The dashboard's own database: SQLite or MySQL

`DATABASE_URL` unset → SQLite at `BULLPANE_DATA_DIR/bullpane.db` (`/data` in the
image). `mysql://…` → MySQL. The free edition's whole promise is "start the
container and open it", and a MySQL to provision was the one step bull-board
never asked for. MySQL stays for what SQLite cannot do: **more than one
replica**. SQLite is one file on one disk, so two instances would each have
their own users and sessions. NFS/EFS is not a disk for this purpose (WAL needs
shared memory between processes on one host).

How one codebase serves both, in `apps/server/src/db/`:

* **Two schemas, one set of types.** `schema.mysql.ts` and `schema.sqlite.ts`
  declare the same tables. The SQLite file asserts its row and insert types
  equal the MySQL ones, so a column added on one side only fails the
  typecheck. Dates are `DATETIME(3)` on MySQL and epoch-ms `INTEGER` on SQLite —
  both come back as `Date` with the millisecond the audit cursor pages on.
* **`schema.ts` picks one at boot.** Services import tables from it, and its
  exports are `let` bindings reassigned once by `createDatabase()`. ES module
  bindings are live, so ~70 query sites stay dialect-blind without threading a
  schema through every constructor. The one rule this imposes: never capture a
  table in a module-level constant.
* **`Db` is typed as MySQL on both.** The builder surface the services use is
  shared, with two exceptions that branch explicitly: the settings upsert
  (`schemaDialect()`), and the RESULT of a write. mysql2 resolves to
  `[ResultSetHeader]` with `affectedRows`, libsql to a ResultSet with
  `rowsAffected` — so a conditional write that counts rows (MCP's single-use
  codes and refresh rotation) goes through `affectedRows()` in
  `ee/mcp/store.ts`, which reads both. Reading `res[0].affectedRows` directly
  is always 0 on SQLite.
* **Two migration histories.** `migrations/mysql/` is what existing installs
  already ran (names are recorded without the directory). `migrations/sqlite/`
  starts at the current schema. A schema change is one file in each, plus both
  schema files.
* **`database.integration.test.ts`** boots the real app on a real database,
  unlocks Pro with a signed license and drives every table through HTTP. It runs
  on SQLite always, and on MySQL with `BULLPANE_TEST_MYSQL_URL`. The other
  suites stub `db`, which proves the calls are built but not that a database
  accepts them.

Known divergence: the MySQL tables use `utf8mb4_unicode_ci`, so queue names that
differ only in case (`Reports` / `reports`) collide there — hiding one is a
no-op once the other is hidden. SQLite compares bytes, as BullMQ does.

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

## Postgres backend (BullMQ 6)

BullMQ 6 can store queues in PostgreSQL. `packages/pg-inspector` implements the
same `Inspector` against BullMQ's own schema (frozen for all of 6.x). The rules
above, read for SQL:

1. **One statement per read.** Multi-queue reads pass the queue names as an
   array (`unnest($1::text[])`), never one query per queue.
2. **Every job query pins `state`.** BullMQ's job indexes are partial and
   state-scoped; a query without the state predicate reads the whole queue.
   Counts are per-state scalar subqueries so each one is an index-only scan.
3. **Truncate in SQL.** `left(data::text, previewBytes)`, and payloads above
   `listFieldCapBytes` are never cast to text (`pg_column_size` reads the
   stored size without detoasting).
4. **Pages walk the index, then join.** The page's ids come off the state's
   partial index (`OFFSET` over a narrow index), and only that page is joined to
   `job`. True keyset pagination needs a cursor in `getJobs`; that is the next
   step for very deep pages (offset 39k on 1M rows: 133 ms).
5. **Discovery is complete from the first call**: `meta` ∪ a loose index scan
   over `job`'s primary key (one probe per queue), so flow-only queues with no
   meta row are listed too.
6. **Writes use the official bullmq API** with `createPostgresBackend`.
7. **The dashboard never migrates a customer's schema.** It checks it with
   BullMQ's `assertSchemaCompatibility` and says `postgres_schema_missing` when
   it is not there.

Model differences and what they cost the customer's database: `docs/POSTGRES.md`.

## How alerts measure (and what they refuse to measure)

`waiting_above` is a **gauge**: `counts.waiting + counts.prioritized`, read from the
state keys. `paused` is deliberately excluded — pausing a queue for maintenance moves
every waiting job into the `paused` list, and counting it made the correct operational
move fire a backlog alert.

`failed_above` and `failed_rate_above` are **rates**, and they come only from BullMQ's
own metrics: the `${prefix}:${queue}:metrics:completed|failed` hashes (`count`,
`prevTS`, `prevCount`) and their per-minute `:data` lists, read by
`Inspector.getWindowMetrics` (`lua/windowMetrics.lua`, one EVALSHA per queue, every
queue of a connection in one pipeline). BullMQ flushes `count - prevCount` into the
list only when a job finishes in a later minute, so the script adds the unflushed
minute to the list entries that fall inside the window and treats the minutes after
`prevTS` as known zeros. The result is exact to the minute from the **first** read: no
history is kept on our side, and a restart does not blind a rule for `windowMinutes`.
`coveredMinutes` reports when the list is shorter than the window (metrics turned on
recently, or `maxDataPoints` below the window); the counts are then a floor.

`duration_above` is the one condition BullMQ metrics cannot answer (they count, they do
not time). It reads the newest completed jobs inside the window — at most 100, one
`HMGET processedOn finishedOn` each, inside the same script — and takes p50/p95 of
`finishedOn - processedOn`. With `removeOnComplete: true` there is nothing to read and
the rule never breaches; with `{ count: N }` the N newest jobs are the ones a recent
window needs.

`ZCOUNT` over the `completed`/`failed` sorted sets — what this used to do — counts only
jobs still present in Redis, so any queue using `removeOnComplete` reports a wildly
inflated failure rate. Measured on a real Redis: 300 ok / 15 failed (4.8%) reads as
50 ok / 15 failed (23.1%). **There is no fallback on purpose.** A queue whose Worker was
not created with `metrics: { maxDataPoints }` gets no error alert; the alert reports
`measurement.state = "no_metrics"`, records one informative `AlertEvent` per cooldown,
and never fires. An absent alert is a known gap; a lying alert costs trust in every
other alert.

Consequences worth knowing:

* A Redis that cannot be read keeps the rule's state (no false "resolved").
* **Only Workers created with `metrics` are counted.** BullMQ increments the counters
  inside the finishing Worker's own script call, so if two deployments process the
  same queue and only one has `metrics`, the other's jobs are never counted and
  nothing in Redis says so (pinned by `attentionIntegration.test.ts`).
* **Only final outcomes are counted.** A job that fails an attempt and succeeds on
  retry is one completed job; retries are invisible to these rules.

**Cost, measured** (500 queues on one connection, one every-queue rule, isolated
Redis 7, per 15 s tick; one EVALSHA per queue, ~0.3 ms each, so no command blocks):

| Rules | Redis CPU per tick | Share of the interval |
|---|---|---|
| failure rate, 15 min | 6.5 ms | 0.04% |
| + p95 duration (100 jobs read per queue) | 66 ms | 0.44% |
| + a 24 h window | 161 ms | 1.08% |
| 24 h + duration | 224 ms | 1.49% |

Cost scales with window length × queues covered, never with job volume. The one
lever if long windows on many queues ever matter: re-read windows above an hour once
a minute instead of every tick, since their per-minute data barely moves in 15 s.
* `getWindowCounts` (ZCOUNT) is retained for panel-side reads, where `retentionSkewed`
  labels it as unreliable. It must not come back into alerting.

## Needs attention is the alert rules, seen on the Overview (Pro)

One rule system, two outputs. An alert is a rule — scope, condition, zero or more
channels — and every tick the engine measures each rule on each queue it covers. The
queues that breach are served by `GET /api/attention` from memory (the Overview polls
it every 5 s at zero Redis cost); the rule as a whole fires and notifies when any of them
breaches. A rule with no channels is "dashboard only".

Scopes are `queue`, `folder`, `connection` (every discovered queue on one Redis) and
`global` (every queue on every connection); the wide ones skip hidden queues. **The most
specific rule wins per condition kind** (queue > folder > connection > global), so
"failure rate > 5% everywhere, > 30% for the importer" is two rules and the importer is
judged by the second one only. Rules at the same level all apply. The same precedence
is applied client-side on the queue page so it never lists a rule that no longer judges
that queue.

Migration `0008` seeds one dashboard-only global rule (failure rate > 10% over 15 min,
min 20 finished jobs) on installs with no alerts, so the section has something to say
on day one.

The free edition keeps the client-side heuristics (`apps/web/src/lib/queueAttention.ts`)
and the two global thresholds. In Pro the rule findings replace the rate/depth
heuristics; paused and "backlog with no worker" stay built in, and rank below every rule
finding because a paused queue is often parked on purpose.

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

Verified against bullmq 5.81.4 and 6.3.4 on a live Redis: `stalled` is an auxiliary SET at
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

| Capability | Free | Pro (USD 39/mo or 390/yr) |
|---|---|---|
| Unlimited connections & queues | ✓ | ✓ |
| Job list / detail / search in data | ✓ | ✓ |
| Add · retry · promote · remove · clean · drain · pause | ✓ | ✓ |
| Bulk retry / promote / remove on a selection (incl. search results) | ✓ | ✓ |
| BullMQ Pro groups & batches view | ✓ | ✓ |
| Login, users & roles (admin / operator / viewer) | – (open, no login) | ✓ |
| Alerts per queue or per folder (waiting, failures, failure %) → Slack / webhook | – | ✓ |
| Folders to organise queues (default: one per connection) | – | ✓ |
| Flow graph (detected from BullMQ flows + manual edges) | – | ✓ |
| Audit log: who did what to which queue, persisted + CSV export | – | ✓ |
| SSO: OIDC + SAML 2.0, configured by the customer's admin in the UI | – | ✓ |
| MCP server: Claude or any MCP client reads and operates queues as the signed-in user | – | ✓ |

Gating is one function on the server (`requireFeature(feature)`) returning HTTP 402
`{ error: "pro_required", feature }`, and one hook on the web (`useEdition()`), so the UI
shows the locked feature with a lock icon and an upsell instead of hiding it.

### Where Pro code lives: `ee/`

The code that implements a Pro feature lives in `apps/server/src/ee/` or
`apps/web/src/ee/`, under the Bullpane Commercial License (`ee/LICENSE`). Everything
else is MIT. The license, not the code layout, is what protects Pro: the source is
public and anyone can delete a gate, but running a build without one in production
breaks the license, and that is what a paying customer's compliance cares about.

The boundary is by feature, not by layer:

* **In `ee/`:** the alerts engine and its services, audit (service + the `onResponse`
  hook), folders, flows, SSO (OIDC, SAML, provider admin, login flow), MCP (`ee/mcp/`), user admin
  routes, the pages that render those features, and their tests.
* **Outside `ee/`:** the gates themselves (`plugins/gates.ts`, `useEdition()`), license
  verification, the edition service, sessions and password login, the DB schema and
  migrations, the shared DTOs in `@bullpane/shared`, and the locked-state UI
  (`LockedFeature`, upsell). Core may import from `ee/` to wire it up; `ee/` may import
  anything from core.

A new Pro feature goes in `ee/` from its first commit.

### The free edition has no login

There is no account, no first-run wizard and no login page until a license unlocks
`users`. `authPlugin` (`auth/plugin.ts`) puts a synthetic **anonymous admin** on every
request that arrives without a valid session, so the ~40 `requireRole` preHandlers keep
working untouched — a route added later cannot forget the rule, because it never learns
about editions in the first place. `/auth/login` and `/setup` answer 402 rather than
401, since "wrong password" would be a lie about an install that has no passwords.

The gate is the `users` feature and not `tier`, because "accounts and roles exist" is
precisely what it means. Flipping a license therefore takes effect on the *next
request*: paste a key and the 401s come back with no restart, drop it and the dashboard
opens again. `openFreeEdition.test.ts` pins both directions.

Two consequences worth stating plainly. Audit rows on a free install have no actor —
they carry the IP and `anonymous`, which is the honest answer on a dashboard anyone
could have reached. And an open instance bound to `0.0.0.0` is an open instance on
whatever network can see it: the server logs a warning at boot and the UI replaces the
account menu with a "No login" badge that opens the upsell. `HOST` still defaults to
`0.0.0.0` because the product ships as a container, where loopback would make it
unreachable.

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

**Auto-provisioning is the one opt-in exception, and it is fenced.** Some teams want
"everyone at the company can look" without inviting forty people. `Settings → SSO`
has a toggle that, for an asserted email whose domain is in an admin-maintained list,
creates the account on first sign-in instead of refusing. The fences are what make it
acceptable: the domain list is mandatory (the server refuses the toggle without one,
because a Google OIDC client authenticates every Google account), matching is exact on
the part after the last `@`, an OIDC `email_verified: false` is refused, the role is
always `viewer` with no password, a disabled row is never re-created, and the login is
audited as `auth.sso_provisioned` rather than `auth.sso_login` so the trail shows who
arrived without an invite. Settings live in the `settings` table
(`sso.auto_provision`, `sso.auto_provision_domains`), not env vars, like `requireSso`.

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
"reads are never audited" (`AUDITED_READS` in `ee/plugins/audit.ts`) — otherwise the trail
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

## MCP: the same API, as the same person

`/mcp` lets an AI client read and operate queues: Claude (claude.ai, Claude Desktop,
Claude Code) or any MCP client that supports OAuth.
Pro, because it only makes sense with accounts: the client acts as a person.

**One rule for the MCP and the dashboard.** A tool never reaches into the inspector.
It is an `/api` call — the one the dashboard makes — run in-process through
`app.inject` as the user who connected the client (`ee/mcp/internal.ts`). So role
guards, zod validation, Pro gates, `BULLPANE_READ_ONLY`, demo mode and the audit hook
apply to the MCP without it knowing they exist, and a route added later is covered by
construction. The identity crosses over in memory: the injected request carries a
per-process nonce and the id of an entry that lives for that one call. The bearer
token is accepted at `/mcp` and nowhere else; `/api` never sees it.

**Effective access = the lowest of three**, re-evaluated on every call:

| | viewer | operator | admin |
|---|---|---|---|
| admin ceiling `read` | read | read | read |
| ceiling `write`, user approved `write` | **read** | write | write |
| ceiling `write`, user approved `read` | read | read | read |
| ceiling `off` | – | – | – |

The ceiling is `Settings → MCP` (`mcp.max_access` in `settings`, default `off`); the
user's choice is made on the consent screen and stored on the grant; the role is read
fresh from `users`. Re-evaluating per call is what makes lowering the ceiling, demoting
someone or disabling them take effect on the next call rather than when a token
expires. The injected user's role is **capped** to match: `read` acts as a viewer,
`write` as at most an operator. An admin's Claude therefore gets a 403 from drain and
obliterate like anyone else's.

**Destructive actions are a link, not a tool.** Drain, clean and obliterate destroy
jobs in bulk and cannot be undone. `request_destructive_action` returns
`/c/:id/q/:queue?confirm=<action>`, which opens that confirmation dialog in the
dashboard, where a human reads the count and the queue name and clicks.

**Audit.** Writes are recorded exactly like the dashboard's — same route, same row —
with `detail.via = "mcp"` and the client's name, so "Ana retried it" and "Ana's Claude
retried it" are distinguishable. Reads are not audited, by the same rule as the
dashboard's. Connecting a client (`mcp.authorize`, refusals included), disconnecting
one (`mcp.revoke`) and changing the ceiling (`mcp.settings_update`) are audited too.

**OAuth 2.1, hand-rolled** for the same reason as OIDC (a handful of hashes and one
HMAC, not a dependency tree): protected-resource and AS metadata at `/.well-known/*`,
dynamic client registration (public clients; redirect URIs must be https, loopback
http or an app scheme, never with a fragment), authorization code with **PKCE S256
mandatory**, `resource` pinned to `<PUBLIC_URL>/mcp`, `iss` in the redirect (RFC 9207).
Unknown clients and unregistered redirect URIs are shown to the user, never redirected
to. The consent request travels through the browser signed (HMAC, 10 min). Codes are
single-use (60 s) and burned on the first attempt, right or wrong. Access tokens are
signed and short (1 h) and carry only the grant id; refresh tokens rotate, and
presenting a rotated one again deletes the whole grant — it means the token leaked.
Codes and refresh tokens are stored as SHA-256. Schema: `migrations/mysql/0009_mcp.sql`.
A new password or disabling the user deletes their grants, like their sessions.

**Stateless transport.** Streamable HTTP with JSON responses only: no SSE stream and
no `Mcp-Session-Id`, so any replica answers any call and nothing lives in memory.

**Reachability is the operator's catch.** Cloud-hosted clients (claude.ai, Claude
Desktop) call `/mcp` from their provider's servers, so they need `PUBLIC_URL` to be
public HTTPS; `Settings → MCP` warns when it looks private. Clients that run on the
user's machine (Claude Code) work on a private network.

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

`ee/plugins/audit.ts` registers a single `onResponse` hook for the whole `/api` tree, next to
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
   gone — and people leaving is the normal audit case, not the edge case. Users are
   disabled rather than deleted for the same reason (`migrations/mysql/0007_user_disabled.sql`),
   but the log does not lean on that: `GET /audit/actors` reads distinct actors out of
   the log itself, so an actor stays filterable whatever happens to the users table.
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

Audit is gated as Pro, and the argument is that it is *only meaningful when the actor has
a name*. The free edition has no login at all, so every row it writes is `anonymous` plus
an IP — a log of what happened, never of who did it. "Who paused this?" is not a question
the free edition can answer for anyone, at any price; it becomes answerable the moment
`users` unlocks accounts and roles, which is the same feature that makes the trail worth
reading. Anyone who needs that answer has a team by definition, and a team on a
USD 39/month licence is not a hard sell.

The counter-argument is real: a solo operator with a regulated customer may need the trail
for an external auditor even with nobody else touching the dashboard. Two things blunt it. First, gating does not
stop the recording — the hook writes rows in every edition; only reading and exporting are
gated, so upgrading later reveals history that was already captured instead of starting
from zero. Second, the page is shown locked with the upsell rather than hidden, so the
capability is discoverable exactly when someone needs it.

Retention is `BULLPANE_AUDIT_RETENTION_DAYS` (default 365, `0` = forever), pruned once a day on
its own timer rather than on the alerts tick — that tick returns early unless alerts are
unlocked, which would let rows grow forever after a licence lapsed. Roughly 350-600 bytes
per row including indexes; a dashboard humans click writes a few hundred rows a day
(~40 MB/year), a script-driven instance at 10k mutating calls/day about 2 GB/year.
