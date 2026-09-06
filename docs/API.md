# REST API contract

All routes are under `/api`, JSON in/out. Auth is a signed httpOnly cookie session (`bmv_session`).
Errors: `{ error: string, message: string, feature?: ProFeature, details?: unknown }`.

Status codes: 400 validation (`error: "validation"`), 401 `unauthenticated`, 403 `forbidden`
(role too low), 402 `pro_required` (with `feature`), 404 `not_found`, 409 `conflict`,
502 `redis_unavailable` (connection failing), 423 `demo_locked` (blocked in DEMO_MODE).

Role column: minimum role. `*` = no auth (setup/login only).
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
| PUT | /license | admin | | `{ key }` → `Edition` (400 `invalid_license`) |
| DELETE | /license | admin | | → `Edition` |
| GET | /connections | viewer | | → `RedisConnection[]` (url redacted, `status` included) |
| POST | /connections | admin | | `CreateConnectionInput` → `RedisConnection` |
| POST | /connections/test | admin | | `testConnectionSchema` → `PingResult` |
| PATCH | /connections/:id | admin | | `UpdateConnectionInput` → `RedisConnection` |
| DELETE | /connections/:id | admin | | → `{ ok }` |
| GET | /connections/:id/overview | viewer | | → `{ info: RedisServerInfo, queues: QueueSummary[], status: ConnectionStatus }` |
| GET | /connections/:id/queues | viewer | | `?refresh=1` forces rediscovery → `QueueSummary[]` |
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
| POST | /connections/:id/queues/:queue/pause | operator | | → `{ ok }` |
| POST | /connections/:id/queues/:queue/resume | operator | | → `{ ok }` |
| POST | /connections/:id/queues/:queue/clean | operator | | `CleanQueueInput` → `{ removed }` |
| POST | /connections/:id/queues/:queue/retry-all | operator | | `{ state: "failed" \| "completed" }` → `{ ok }` |
| POST | /connections/:id/queues/:queue/drain | admin | | `{ includeDelayed?: boolean }` → `{ ok }` |
| POST | /connections/:id/queues/:queue/obliterate | admin | | → `{ ok }` |
| GET | /connections/:id/queues/:queue/groups | viewer | | `?page&pageSize` → `{ groups: GroupSummary[], total }` |
| GET | /connections/:id/queues/:queue/groups/:groupId/jobs | viewer | | `?page&pageSize` → `JobsPage` |
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
| PATCH | /users/:id | admin | users | `UpdateUserInput` → `User` |
| DELETE | /users/:id | admin | users | → `{ ok }` (cannot delete yourself / last admin) |

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

`QueueSummary.rates` (trailing 60 min completed/failed + successPct) is now included in every
queues/overview response. It costs two `ZCOUNT`s per queue inside the same stats script.

### Alerts scope (round 2)

`connection_down` was removed. An alert now has `scope`:
`{ type: "queue", connectionId, queueName }` or `{ type: "folder", folderId }`.
A folder alert evaluates every queue in the folder and fires when any breaches (worst queue is
reported in the event and the notification). `AlertEvent.connectionId` is nullable.
The Queue page offers "Create alert" which opens the alert dialog pre-scoped to that queue.

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
