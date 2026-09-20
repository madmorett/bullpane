# REST API contract

All routes are under `/api`, JSON in/out. Auth is a signed httpOnly cookie session (`bullpane_session`).
Errors: `{ error: string, message: string, feature?: ProFeature, details?: unknown }`.

Status codes: 400 validation (`error: "validation"`), 401 `unauthenticated`, 403 `forbidden`
(role too low), 402 `pro_required` (with `feature`), 404 `not_found`, 409 `conflict`,
502 `redis_unavailable` (connection failing), 423 `demo_locked` (blocked in DEMO_MODE).

Role column: minimum role. `*` = no auth (setup/login only).

**On the free edition every role is satisfied.** There is no login: requests without a
session get a synthetic anonymous admin, so the whole table behaves as `*` until a
license unlocks `users`. `/auth/login` and `/setup` then answer **402 `pro_required`**
instead of 401 — there are no passwords to be wrong about. `SetupStatus.authRequired`
is how a client tells the two worlds apart. See "The free edition has no login" in
`ARCHITECTURE.md`.
Pro column: the feature that gates the route (402 in free edition).

| Method | Path | Role | Pro | Body / Query → Response |
|---|---|---|---|---|
| GET | /health | * | | `{ ok, version, uptime }` |
| GET | /setup/status | * | | → `SetupStatus` |
| POST | /setup | * | | `SetupInput` → `MeResponse` (only when no users exist; 409 otherwise) |
| POST | /auth/login | * | | `LoginInput` → `MeResponse` |
| POST | /auth/logout | viewer | | → `{ ok }` |
| GET | /auth/me | viewer | | → `MeResponse` |
| GET | /edition | * | | → `Edition` (public: the login page shows the tier) |
| GET | /license | admin | | → `Edition` |
| PUT | /license | admin | | `{ key }` → `Edition`. Offline token: verified locally. Subscription key: activated through the license API (400 `invalid_license`, 409 `license_already_activated`, 502 `license_server_unavailable`) |
| DELETE | /license | admin | | → `Edition`. Releases the activation at the store (best effort) |
| POST | /license/refresh | admin | | → `Edition`. Re-checks a subscription key now; never fails, see `license.status` |
| GET | /connections | viewer | | → `RedisConnection[]` (url redacted, `status` included) |
| POST | /connections | admin | | `CreateConnectionInput` → `RedisConnection` |
| POST | /connections/test | admin | | `testConnectionSchema` → `PingResult` |
| PATCH | /connections/:id | admin | | `UpdateConnectionInput` → `RedisConnection` |
| DELETE | /connections/:id | admin | | → `{ ok }` |
| GET | /connections/:id/overview | viewer | | → `{ info: RedisServerInfo, queues: QueueSummary[], status: ConnectionStatus, hiddenCount: number }` |
| GET | /connections/:id/queues | viewer | | `?refresh=1` forces rediscovery, `?includeHidden=1` keeps hidden queues in → `QueueSummary[]` |
| GET | /connections/:id/hidden-queues | viewer | | → `HiddenQueue[]` (queue name, when, who) |
| POST | /connections/:id/hidden-queues | operator | | `hideQueueSchema` (`{ queueName }`) → `HiddenQueue[]` (201, idempotent) |
| DELETE | /connections/:id/hidden-queues/:queueName | operator | | → `HiddenQueue[]` (idempotent) |
| GET | /connections/:id/queues/:queue | viewer | | → `QueueSummary` (with `metrics`) |
| GET | /connections/:id/queues/:queue/jobs | viewer | | `listJobsQuerySchema` → `JobsPage` |
| GET | /connections/:id/queues/:queue/jobs/search | viewer | | `searchJobsQuerySchema` → `JobSearchResult` |
| POST | /connections/:id/queues/:queue/jobs | operator | | `AddJobInput` → `{ id }` |
| GET | /connections/:id/queues/:queue/jobs/:jobId | viewer | | → `JobDetail` |
| GET | /connections/:id/queues/:queue/jobs/:jobId/logs | viewer | | `?start&end` → `{ logs, count }` |
| DELETE | /connections/:id/queues/:queue/jobs/:jobId | operator | | → `{ ok }` |
| POST | /connections/:id/queues/:queue/jobs/:jobId/retry | operator | | → `{ ok }` |
| POST | /connections/:id/queues/:queue/jobs/:jobId/promote | operator | | → `{ ok }` |
| POST | /connections/:id/queues/:queue/jobs/:jobId/discard | operator | | → `{ ok }` |
| POST | /connections/:id/queues/:queue/jobs/bulk/retry | operator | | `bulkJobActionSchema` (`{ jobIds }`) → `BulkJobActionResult` |
| POST | /connections/:id/queues/:queue/jobs/bulk/remove | operator | | `bulkJobActionSchema` → `BulkJobActionResult` |
| POST | /connections/:id/queues/:queue/jobs/bulk/promote | operator | | `bulkJobActionSchema` → `BulkJobActionResult` |
| POST | /connections/:id/queues/:queue/pause | operator | | `PauseQueueInput` (optional `reason`, ≤ 500 chars, kept in the audit row's `detail`, never in Redis) → `{ ok }` |
| POST | /connections/:id/queues/:queue/resume | operator | | → `{ ok }` |
| POST | /connections/:id/queues/:queue/clean | operator | | `CleanQueueInput` → `{ removed }` |
| POST | /connections/:id/queues/:queue/retry-all | operator | | `{ state: "failed" \| "completed" }` → `{ ok }` |
| POST | /connections/:id/queues/:queue/drain | admin | | `{ includeDelayed?: boolean }` → `{ ok }` |
| POST | /connections/:id/queues/:queue/obliterate | admin | | → `{ ok }` |
| GET | /connections/:id/queues/:queue/schedulers | viewer | | `listSchedulersQuerySchema` (`?page&pageSize`) → `SchedulersPage` |
| DELETE | /connections/:id/queues/:queue/schedulers/:key | operator | | → `{ ok }` (404 when the id is unknown) |
| GET | /connections/:id/queues/:queue/groups | viewer | | `?page&pageSize` → `GroupsPage` (`{ groups: GroupSummary[], total, byStatus }`; per group: status, waiting, prioritized, active, concurrency, rateLimit, limitedUntil, since) |
| GET | /connections/:id/queues/:queue/groups/:groupId/jobs | viewer | | `?page&pageSize` → `JobsPage` (the group's list, then its prioritized zset) |
| GET | /connections/:id/flows | viewer | flows | `?sample=200` → `FlowGraph` |
| POST | /flow-edges | operator | flows | `createFlowEdgeSchema` → `FlowEdge` |
| DELETE | /flow-edges/:id | operator | flows | → `{ ok }` |
| GET | /folders | viewer | folders | → `Folder[]` |
| POST | /folders | operator | folders | `createFolderSchema` → `Folder` |
| PATCH | /folders/:id | operator | folders | `updateFolderSchema` → `Folder` |
| DELETE | /folders/:id | operator | folders | → `{ ok }` |
| PUT | /folders/:id/queues | operator | folders | `setFolderQueuesSchema` → `Folder` |
| GET | /alerts | viewer | alerts | → `Alert[]` |
| POST | /alerts | operator | alerts | `CreateAlertInput` → `Alert` |
| PATCH | /alerts/:id | operator | alerts | `updateAlertSchema` → `Alert` |
| DELETE | /alerts/:id | operator | alerts | → `{ ok }` |
| POST | /alerts/:id/test | operator | alerts | sends a test notification → `{ ok, results: [{channel, ok, error}] }` |
| GET | /alerts/events | viewer | alerts | `?limit=100&alertId=` → `AlertEvent[]` |
| GET | /users | admin | users | → `User[]` |
| POST | /users | admin | users | `CreateUserInput` → `User` |
| PATCH | /users/:id | admin | users | `UpdateUserInput` → `User` (`disabled: true` revokes sessions and refuses logins; cannot disable yourself / the last active admin) |

There is no `DELETE /users/:id`. Users are disabled, never deleted: the id stays so audit
rows and everything else that recorded this person keep resolving, and re-inviting the same
email is a re-enable, not a new account (`POST /users` answers 409 for a disabled email).
| GET | /audit | admin | audit | `listAuditQuerySchema` → `AuditPage` |
| GET | /audit/actors | admin | audit | → `{ id, name, email }[]` (distinct actors in the log, disabled users included) |
| GET | /audit/export | admin | audit | same query → `text/csv` attachment |

Notes
* `/connections/:id/queues` merges the cached discovery list with one pipelined
  `getQueueStats` call. This is the endpoint the sidebar polls (every 5 s by default).
* Folders in the free edition: the UI renders one implicit folder per connection. Nothing is stored.
* In `DEMO_MODE`, mutating `/connections`, `/users` (except viewing), `/license` and `/setup`
  return 423 `demo_locked`. Job/queue actions stay allowed so people can play.
* Pro gate is checked before role, so a viewer on the free edition sees 402 (upsell), not 403.

## Additions (round 2)

| Method | Path | Role | Pro | Body / Query → Response |
|---|---|---|---|---|
| GET | /connections/:id/queues/:queue/setup | viewer | | → `QueueSetup` (meta hash, limiter TTL, workers via CLIENT LIST, group settings; cached 10 s) |
| GET | /connections/:id/queues/:queue/jobs?groupId= | viewer | | when `groupId` is set the page comes from that Pro group's list and `state` is ignored |
| GET | /connections/:id/overview | viewer | | → `{ info, queues, status, hiddenCount, discovery: DiscoveryStatus }` — `discovery.complete` is false until one full SCAN cycle finished (large keyspaces) |

`JobSummary.dataBytes` is the payload size (HSTRLEN). Payloads above the list cap (32 KiB) are not read:
`dataPreview` is `""` with `dataTruncated: true`. `JobSearchResult.skippedLargePayloads` counts jobs whose
data was above the search cap (256 KiB) and matched on id / name / error only.

`QueueSummary.rates` (trailing 60 min completed/failed + successPct) is now included in every
queues/overview response. It costs two `ZCOUNT`s per queue inside the same stats script.

### Alerts scope (round 2)

`connection_down` was removed. An alert now has `scope`:
`{ type: "queue", connectionId, queueName }` or `{ type: "folder", folderId }`.
A folder alert evaluates every queue in the folder and fires when any breaches (worst queue is
reported in the event and the notification). `AlertEvent.connectionId` is nullable.
The Queue page offers "Create alert" which opens the alert dialog pre-scoped to that queue.

### Hidden queues

A queue the team stopped using still shows up in the sidebar, the cards, the table
and every queue selector. `hidden_queues` (migration `0003_hidden_queues.sql`) takes it
out of those lists. It is **not** `obliterate`: no Redis key is written or deleted, every
job stays where it is, and the row can be removed at any time.

Scope is the **instance, not the user**. If a lead hides a dead queue it is dead for the
whole team; a dashboard that looks different per person is a liability during an incident.
`hidden_by` records who did it so the choice is traceable. Minimum role to change it is
`operator` — the same level as pausing a queue. Reading the list is `viewer`, so anyone can
see what is being kept out of their view and by whom.

**Where the filter lives.** In the service layer (`ConnectionsService.listQueues`), never in
the inspector's discovery. Consequences, all intentional:

* `listQueues` returns only visible queues by default; `{ includeHidden: true }`
  (`?includeHidden=1`) returns everything. Hidden names are dropped between discovery and
  the stats pipeline, so a hidden queue costs no Redis work in the list path.
* `GET /connections/:id/queues/:queue` and every sub-route (jobs, search, setup,
  schedulers, groups, actions) are **untouched**: a hidden queue stays fully reachable by
  direct URL. The web shows a "this queue is hidden" banner with a reveal button, rendered
  from the app shell so every queue sub-route carries it.
* **Alerts and health do not filter.** The alerts engine reads the inspector directly, so
  hiding a queue never silences an alert on it and never stops it being measured. Hiding is
  about the list, not about switching the queue off.
* Aggregate strips ("ALL QUEUES · N queues · N waiting") sum **only the visible queues**
  and print `N hidden` next to the totals, clickable to reveal the list. A hidden queue must
  never pad a total silently.

`DELETE /connections/:id` removes that connection's `hidden_queues` rows along with its
folder assignments, alerts and flow edges. Global read-only mode needs no extra gate here:
the `blockWrites` hook refuses every non-GET under `/api`.

### Redis health monitor (round 3)

| Method | Path | Role | Pro | Response |
|---|---|---|---|---|
| GET | /health/connections | viewer | | `ConnectionHealth[]` — one per configured connection |
| GET | /health/connections/:id | viewer | | `ConnectionHealth` |

`ConnectionHealth` carries the parsed `RedisServerInfo` (now including RSS, peak,
fragmentation, maxmemory policy, blocked clients, hit rate, evicted/expired keys, rejected
connections, replicas, persistence status and the INFO round-trip latency), plus rates the
server derives by diffing consecutive samples (`commandsPerSec`, `cpuCores`), `memoryUsedPct`,
a rolling `history` for sparklines, and server-computed `warnings`.

One INFO per connection per poll, rate-limited to one every 2 s and shared across all
browser tabs (`apps/server/src/services/health.ts`). Rates are null on the first sample and
after a counter reset. Poll it every 3-5 s.

### Job schedulers (round 4)

Job schedulers (BullMQ's "repeatable jobs") are not in any of the 8 job states. BullMQ keeps
them in `${prefix}:${queue}:repeat` (zset: scheduler id → next run, unix ms) plus one hash per
scheduler at `${prefix}:${queue}:repeat:${id}` holding `name`, `pattern` or `every`, `tz`,
`offset`, `limit`, `ic` (iteration count), `startDate`, `endDate` and the template `data`/`opts`.
The job a scheduler has queued next is a normal delayed job whose id is `repeat:${id}:${millis}`.

`GET .../schedulers` is one EVALSHA (`getSchedulers.lua`): `ZCARD` for the total, `ZRANGE`
(ordered by next run) for the page, then one `HMGET` per row of the page. `data`/`opts` are
truncated inside Lua to `previewBytes`, so `SchedulersPage.schedulers[].template` carries raw,
possibly truncated JSON strings.

`DELETE .../schedulers/:key` goes through `queue.removeJobScheduler(key)` so the delayed job the
scheduler had already queued is removed with it; a hand-written `DEL` would orphan that job.
Refused with 423 `demo_locked` in global read-only mode (the `blockWrites` hook).

`QueueSummary.schedulersCount` is a `ZCARD` on `repeat` folded into the existing `queueStats`
script — no extra round trip — and drives the count on the Schedulers tab.

### Audit log (round 5, Pro)

The trail already existed as pino lines (`{ queue, jobId, by }`) in every mutating
handler. A log file that dies with the container and that nobody can query is a
debugging aid, not an audit trail. `audit_log` (migration `0004_audit_log.sql`) is the
same information, persisted, filterable and exportable.

**Read-only, admin.** There is no POST, no PATCH and no DELETE — deliberately. A log an
admin can edit or clear from the UI answers "what happened?" with "whatever the last
admin wanted you to believe". Rows leave only by age, through the retention job. The role
is `admin` and not `operator`, because the log shows admin-only actions (connections,
users, license) and reading who changed access is a different right from pausing a queue.

**Instrumentation is one global `onResponse` hook** (`plugins/audit.ts`), registered in
`routes/index.ts` next to `blockWrites` and for the same reason: a single choke point
beats remembering to instrument each handler. A per-handler call that someone forgets
leaves a hole nobody notices until an auditor asks; a route missing from the map logs a
warning the first time it is called. The hook derives the action from
`method + request.routeOptions.url` (the PATTERN, so a queue named `pause` cannot fake a
match), the actor from `request.user`, the target from the route params, and the result
from the status code.

It is a **hybrid**, because a hook cannot see "3,412 jobs were cleaned": handlers enrich
the row with `request.auditDetail({...})` / `request.auditTarget({...})`, which merge into
what the hook writes. A handler that adds nothing still produces a complete row.

* **Only mutating requests.** GET/HEAD/OPTIONS are never recorded — the sidebar polls
  `/queues` every 5 s per connection, so auditing reads would write millions of rows
  saying nothing and bury the twelve that matter.
* **Failures are recorded** with `result: "error"` and the mapped API error
  (`forbidden: This action requires the admin role`). "Tried to obliterate the payments
  queue and got a 403" is exactly what an auditor is looking for and never appears in a
  success-only log.
* **`auth.login_failed`** is its own action, not an errored `auth.login`. The attempted
  email goes in `detail`; whether that email exists is deliberately not recorded, so the
  log cannot be used as an account-enumeration oracle.
* **Not audited, on purpose:** `POST /connections/test` (a throwaway ping, writes
  nothing), `POST /setup` (creates the first admin when there is no actor yet, once per
  install), `POST /alerts/:id/test` (changes no state), and the folder / flow-edge routes
  (cosmetic layout; no queue, job or access change).

**The actor and the connection are denormalised** (`actor_email`, `actor_name`,
`actor_role`, `connection_name`) with **no FK to `users` or `connections`**. A trail whose
only pointer to the person is a foreign key stops meaning anything the moment that user is
deleted — and "the person who did it left the company" is the normal audit case, not the
edge case. `GET /audit/actors` therefore reads distinct actors out of the log itself, so
deleted people stay filterable.

**`detail` never carries a job payload.** It holds the PARAMETERS of the action (clean
state/grace/limit and how many were removed, the job NAME added and its payload size in
bytes, which fields of a user changed, the licensee) — never `job.data`, which routinely
holds customer PII and would end up in a CSV export. `sanitizeDetail` in
`services/audit.ts` strips `data`, `payload`, `body`, `returnvalue`, `password`, `url`,
`token`, `secret` and `key` at any depth, so the rule is enforced in one place instead of
depending on every future handler remembering it. There is a test for exactly this.

**`AuditService.record` never throws.** A failing insert (MySQL down, an old image whose
table does not exist) is logged at error level and the request proceeds. The trade-off is
explicit: a gap in the trail beats a 500 for the operator resuming the payments queue at
3 a.m.

**Paging is keyset**, not `OFFSET`: `AuditPage.nextCursor` is an opaque
`<epoch ms>.<id>` fed back as `?cursor=`, matched by the `(created_at, id)` index, so page
40 of a million rows costs what page 1 does.

`GET /audit/export` streams the same query in internal pages of 500 and stops at 50,000
rows, appending a `# truncated at ...` comment line rather than silently losing the second
half of the year. Cells are RFC-4180 quoted and any leading `=`/`+`/`-`/`@` is prefixed
with `'`, so a crafted user-agent string cannot become a spreadsheet formula.

**Retention** is `BULLPANE_AUDIT_RETENTION_DAYS` (default 365, `0` = forever), pruned once a
day on its own timer — not on the alerts tick, which returns early unless alerts are
unlocked and would let rows grow forever after a license lapsed. Size is roughly 350-600
bytes per row including indexes: a few hundred rows a day for a dashboard humans click
(~40 MB/year), ~2 GB/year for an instance driven by scripts at 10k mutating calls/day.

### Bulk job actions (round 6)

Between "one job" and "every job in the state" there was nothing, and the real
case is the middle one: failures arrive clustered (one tenant's webhook
answering `HTTP 410`), the server-side search finds exactly those 50, and the
operator wants to retry those and drop the rest.

```
POST /connections/:id/queues/:queue/jobs/bulk/{retry|remove|promote}
     { "jobIds": ["1", "2", "3"] }
→ 200 { "action": "retry", "ok": ["1","3"], "failed": [{ "jobId": "2", "reason": "job_not_found" }], "requested": 3 }
```

Four rules, all deliberate:

* **An explicit ceiling per call** — `BULK_JOB_LIMIT` (500), validated in the
  zod schema, so more ids is `400 validation` with the limit in the message,
  refused before a single Redis command runs. Without a ceiling someone pastes
  100k ids and pins the customer's Redis, which is exactly what the performance
  contract exists to prevent. An empty list is also a 400.
* **Partial results are the rule, not the exception, and they come back with
  200.** An id may have been pruned between the listing and the click, may be in
  a state the action does not allow (`promote` on a waiting job), or may fail
  inside BullMQ's script. Aborting on the first error would hide the 47 that
  worked; the operator needs to know precisely which 3 of the 50 did not go.
  `failed[].reason` carries BullMQ's own message (`job_not_found`,
  `cannot_retry_job_in_state_active`).
* **The official bullmq API, reused per id** — `Inspector.bulkJobAction` calls
  the same `retryJob` / `removeJob` / `promoteJob` the single-job routes call, so
  the atomic scripts keep handling indexes, flow dependencies and locks. A
  hand-written `DEL` would orphan all three.
* **Bounded concurrency** (`BULK_CONCURRENCY = 8`), not `Promise.all` over 500.
  500 simultaneous EVALSHAs queue commands ahead of the customer's own workload;
  a small window finishes in a comparable time and leaves Redis breathing.
  Duplicate ids are de-duplicated, so `requested` can be lower than the array
  length.

Audited as `job.bulk_retry` / `job.bulk_remove` / `job.bulk_promote` — separate
actions from the single-job ones, because "retried 50 jobs" and "retried a job"
are different events to whoever is auditing. The `detail` carries
`{ requested, ok, failed }` plus at most 10 `"<id>: <reason>"` strings, and
**never a job payload** (there is a test for exactly that).
`job.bulk_remove` is in `AUDIT_HIGH_RISK_ACTIONS` alongside `job.remove`.

### Stalled jobs (round 6)

`stalled` is **not** a job state and the API never pretends it is. Verified
against bullmq 5.81.4 and 6.3.4 on a live Redis: it is an auxiliary SET at
`${prefix}:${queue}:stalled` that only exists while something is stuck,
`getState()` on a stalled job returns `active`, and `stalled` is not in
`JOB_STATES`. A stalled job is an `active` job whose worker died without
renewing its lock.

Two fields expose it instead:

* `QueueSummary.stalledCount` — `SCARD` on that SET, folded into the existing
  `queueStats` script (one extra O(1) command in the same EVALSHA, no extra
  round trip). It lives outside `counts` on purpose, so no total is inflated by
  jobs that are already counted as `active`.
* `JobSummary.stalledCounter` / `JobDetail.stalledCounter` — the job hash field
  `stc`, which BullMQ's `Job.fromJSON` reads as `stalledCounter` and
  `moveStalledJobsToWait-9.lua` increments with `HINCRBY` when it recovers the
  job. `> 0` is the durable trace that this job stalled at least once, and it is
  the only honest answer to "why did this job run twice?".

The check runs in two passes (`moveStalledJobsToWait-9.lua`): the first marks
every `active` id into the SET, the next one moves the ones whose `:lock` is
gone back to `wait`, bumps `stc` and `DEL`s the SET. So `stalledCount` is a
transient reading between two rounds of the check, and `stalledCounter` is the
permanent one. The UI shows the count as a warning on the `active` tab
("N of these are stalled (worker lost the lock)") and the counter as a badge on
the job row — and deliberately does **not** add a "stalled" tab.

### When a delayed job runs (round 7)

* `JobSummary.delayedUntil` / `JobDetail.delayedUntil` — unix ms at which a
  `delayed` job becomes runnable, `null` in every other state. Decoded from the
  job's score in the `delayed` zset (`timestamp * 0x1000 + jobId % 0x1000`, the
  encoding BullMQ has used since Bull 3), which `getJobs` / `searchJobs` now read
  with `WITHSCORES` and `getJob` with one `ZSCORE` — same EVALSHA, no extra round
  trip. The hash's `delay` field is not enough: after a backoff retry or
  `moveToDelayed` it holds the relative delay of that move with no record of when
  the move happened.

### Users are disabled, not deleted (round 7)

`DELETE /users/:id` is gone. `PATCH /users/:id { disabled: true }` revokes the
person's sessions and refuses their next login, password or SSO (`401` with a
"disabled" reason in the audit detail); `{ disabled: false }` re-enables. The row
and its id stay, so audit rows and everything else that named this person keep
resolving. Guards mirror the old delete: not yourself, not the last *active*
admin. `POST /users` answers `409` for a disabled email — re-enable instead.
Audit actions `user.disable` / `user.enable` were added; `user.delete` stays in
the enum for rows written before this change.

## SSO (Pro)

Two groups of routes with deliberately different gating.

**Admin CRUD** — `requireFeature("sso")` then `requireRole("admin")`, so the free
edition gets `402 { error: "pro_required", feature: "sso" }` and a non-admin gets 403:

| Method | Path | Notes |
|---|---|---|
| GET | `/api/sso/providers` | Secrets stripped. `hasSecret: true/false`, plus the `callbackUrl` and (SAML) `entityId` the admin must enter at the IdP. |
| POST | `/api/sso/providers` | `{ kind: "oidc" \| "saml", name, config }`. OIDC requires `clientSecret`; it is encrypted at rest and never returned. |
| PATCH | `/api/sso/providers/:id` | `config` merges into the stored one, so the issuer can be fixed without re-typing the secret. Omit `clientSecret` to keep it; an empty string is refused (400) rather than silently clearing a working secret. `kind` is immutable. |
| DELETE | `/api/sso/providers/:id` | 409 when it is the last enabled provider and `requireSso` is on. |
| POST | `/api/sso/providers/:id/test` | Discovery only, performs no login. A failure is `200 { ok: false, message }` — a bad issuer is information for the form, not a server error. |
| GET | `/api/sso/settings` · PUT | `{ requireSso: boolean }`. Turning it on with no enabled provider is 409. |
| GET | `/api/sso/metadata` | SAML SP metadata XML, so the IdP can be configured by file upload. |

**The login flow** — unauthenticated by necessity, and **not** wrapped in
`requireFeature()`: the check is inside the handler so an expired license degrades to
"SSO is off, use your password" instead of a 402 JSON page mid-redirect.

| Method | Path | Notes |
|---|---|---|
| GET | `/api/auth/sso/options` | What the login page may know before anybody is authenticated: `{ providers: [{id, kind, name}], requireSso, passwordEscapeHatch }`. Carries no issuer, no client id. Empty list on the free edition. |
| GET | `/api/auth/sso/:id/start` | 302 to the IdP. Sets a signed, single-use, `httpOnly` flow cookie holding `state`, `nonce` and the PKCE verifier. `?next=` accepts a local path only. |
| GET/POST | `/api/auth/sso/:id/callback` | One route, two bindings: OIDC returns `GET ?code&state`, SAML posts `SAMLResponse`+`RelayState`. On success, the **same** session cookie and TTL as a password login, with `sessions.auth_method = 'sso'`. |

Every refusal is a `302` to `/login?sso_error=<one sentence>` — the user is in a
browser mid-redirect. The detail goes to the log and the audit trail
(`auth.sso_login`, `auth.sso_denied`), never to the URL.

Users: `POST /api/users` now takes `password` as **optional**. Omitted → NULL
`password_hash` → an SSO-only account that cannot sign in with a password at all,
not even through the admin escape hatch.
