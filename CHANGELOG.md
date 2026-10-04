# Changelog

Every user-visible change to Bullpane. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[semantic versioning](https://semver.org/).

Docker images are published per tag: `ghcr.io/<owner>/bullpane:0.1.0`, `:0.1`,
`:latest`, plus `:edge` for every push to `main`.

The public page at [bullpane.com/changelog](https://bullpane.com/changelog) is
written from this file — when you add an entry here, mirror it there
(`apps/website/public/changelog.html`).

## [Unreleased]

### Added

- **BullMQ on Postgres.** BullMQ 6 can keep its queues in PostgreSQL, and
  Bullpane now reads and operates them: add a connection of kind *Postgres*
  (or `"kind": "postgres"` in `BULLPANE_CONNECTIONS`) with the database URL and
  the schema (BullMQ's default, `bullmq`). Queues, counts, job lists, search,
  job detail, logs, schedulers, flows, metrics, alerts and every action work as
  on Redis. Requires the schema written by BullMQ ≥ 6.0.3; Bullpane never runs
  migrations on your database. See `docs/POSTGRES.md`.
- **Postgres health card**: connections against `max_connections`,
  transactions/sec, database and table sizes, and a warning when BullMQ's
  `event` table (never trimmed by BullMQ 6) passes 1 GiB.

- **Works where Postgres actually runs**: behind PgBouncer and other
  transaction poolers (reads fall back to one READ ONLY transaction each when
  the pooler refuses or drops startup options), over TLS with the URL your
  provider gives you (`sslmode=require` means what it means in psql), and with
  a read-only role (browsing works; actions answer
  `403 database_permission_denied`).

### Changed

- The health monitor is now "Server health": its wording no longer assumes Redis.
- Counts of big states (100k+ jobs) are still exact but refreshed less often,
  up to once a minute from 3M jobs, so a large install does not keep a core of
  its database busy recounting.

### Tested

- `pnpm smoke:postgres` (apps/smoke): every feature end to end against a real
  Postgres, real BullMQ workers and a real browser, plus a load test proving
  the dashboard's reads take no locks a worker can wait on and leave worker
  throughput within noise with 10 tabs open. It found that counts on big
  states ran as 3-core parallel scans and starved the workers; dashboard
  queries are now single-core and counts are shared per queue for 2 s.

## [0.5.1] — 2026-10-04

### Added

- **No database to set up.** Without `DATABASE_URL`, Bullpane now keeps its own
  data (connections, settings, and on Pro users, alerts, folders, the audit log)
  in a SQLite file at `BULLPANE_DATA_DIR/bullpane.db` — `/data` in the image.
  `docker run -p 3000:3000 -v bullpane-data:/data ghcr.io/madmorett/bullpane`
  is the whole install. Mount a volume on `/data`, or the data dies with the
  container. `DATABASE_URL=file:/path/to/bullpane.db` picks another file.
- **MySQL is unchanged and still supported.** An install that sets
  `DATABASE_URL=mysql://…` keeps using MySQL, with the same schema and no
  migration on upgrade. Use MySQL when you run more than one replica: SQLite is
  one file on one disk, so two instances would each see their own users and
  sessions. Do not put the SQLite file on NFS/EFS. There is no SQLite → MySQL
  data migration yet.

### Changed

- The default when `DATABASE_URL` is unset used to be
  `mysql://bullpane:bullpane@localhost:3306/bullpane`. It is now SQLite. Every
  compose file and deploy script in this repository sets `DATABASE_URL`
  explicitly; an install that relied on the old default must set it to keep
  its MySQL data. The boot banner says which database is in use.
- `docker-compose.yml` starts MySQL only when asked: `COMPOSE_PROFILES=mysql`
  plus `DATABASE_URL=mysql://bullpane:bullpane@mysql:3306/bullpane` in `.env`.
  Without them it runs the app alone on SQLite. The company/trial composes and
  the EC2 installer still bundle MySQL. **If you ran this repository's
  `docker-compose.yml` with its bundled MySQL**, add those two lines before
  updating: the volume is the same `mysql-data`, so your data is where you left
  it. Without them the app starts on an empty SQLite database.
- A `DATABASE_URL` that is neither `mysql://` nor `file:` now stops the boot
  with an error instead of being handed to the MySQL driver.

### Fixed

- **A database blip during an alerts tick no longer crashes the server (Pro).**
  With a rule covering every queue — the default rule is one — a failed read of
  the connection list left an unhandled promise rejection, which stops a Node 22
  process. The tick now fails, logs, and the next one runs.

## [0.5.0] — 2026-10-04

### Added

- **MCP server (Pro).** Paste `<PUBLIC_URL>/mcp` into Claude (claude.ai, Claude
  Desktop, Claude Code) or any MCP client that supports OAuth, sign in with your
  Bullpane login or SSO, and pick
  **read** or **read & write** on the consent screen. A client acts as you: what
  you cannot do in the dashboard it cannot do either, because every tool is the
  same `/api` call the dashboard makes. Effective access is the lowest of the
  admin's ceiling (`Settings → MCP`: off / read / read & write, default off), what
  you approved and your role — a viewer never writes — and it is re-checked on
  every call. Writes are in the audit log with `via: mcp`. Drain, clean and
  obliterate are never run from MCP: the client gets a link that opens the
  confirmation dialog. OAuth 2.1 with PKCE, dynamic client registration and
  rotating refresh tokens; connected clients can be disconnected from Settings.
  Cloud-hosted clients (claude.ai, Claude Desktop) need `PUBLIC_URL` to be public HTTPS.

### Fixed

- **Promoting a job scheduler's delayed job no longer skips the next run.**
  bullmq computes a scheduler's next iteration from the scheduled time of the job
  that just ran, so promoting a daily job ran tomorrow's iteration today and left
  tomorrow empty. Promoting one now asks: **run a copy now** (the job stays in place,
  a one-off copy with the same name, data and options runs, the next run still
  happens) or **promote and skip the next run** (bullmq's own promote). The API
  defaults to the copy (`{ "scheduler": "run_copy" | "skip_next" }`), and so does
  bulk promote. Job rows now carry `repeatJobKey`.

## [0.4.0] — 2026-10-04

### Changed

- **Licensing is now open core.** The code of the Pro features moved to
  `apps/server/src/ee/` and `apps/web/src/ee/` and is licensed under the
  Bullpane Commercial License: readable and modifiable, free for development and
  testing, a Pro subscription for production. Everything else stays MIT.
  Releases up to 0.3.0 remain MIT in full. No behaviour changed.

### Added

- **`BULLPANE_CONNECTIONS`**: a JSON array of Redis connections created at boot
  when no connection of that name exists. Never overwrites a connection edited in
  the UI, works in read-only mode, and a bad entry fails the boot naming the field
  without printing the URL. For installs configured only by environment.

## [0.3.0] — 2026-09-27

### Added

- **Needs attention is driven by alert rules (Pro).** Every queue that breaks an
  enabled rule gets a card at the top of the Overview with the value, the window and
  the threshold (`26% failed · 15m > 10%`, `p95 4.2s · 15m > 2s`, `674 waiting > 200`).
  A rule without channels is dashboard only; with Slack or a webhook it also notifies.
- **Rules scoped to every queue or to a whole connection**, besides one queue and a
  folder. The most specific rule wins per condition kind, so "5% everywhere, 30% for
  the importer" is two rules. Hidden queues are skipped by the wide scopes.
- **Processing time rule** (`duration_above`): p50 or p95 of the jobs completed in the
  window, from up to the 100 newest completed jobs.
- A starting dashboard-only rule on installs with no alerts: failure rate above 10%
  over 15 minutes, on every queue with at least 20 finished jobs.
- The Overview says how many queues cannot be measured because their Workers keep no
  BullMQ metrics.

### Changed

- Failure rules read BullMQ's per-minute metrics lists instead of diffing counters in
  memory: exact to the minute from the first evaluation, so a restart no longer puts
  every rule in "warming up" for a whole window.
- In Pro, the free edition's heuristics for failing, deep and failed-pile queues are
  replaced by the rules; paused and "backlog with no worker" stay built in and rank
  below rule findings.
- **Behaviour change for existing alerts:** when a queue rule and a folder rule of the
  same kind both cover a queue, only the queue rule judges it now.

### Known limits

- Failure rules count only jobs finished by Workers created with
  `metrics: { maxDataPoints }`. A queue processed by two deployments where only one
  has `metrics` is undercounted, silently.
- A job that fails an attempt and succeeds on retry counts as completed.
- Processing time needs completed jobs to still be in Redis: with
  `removeOnComplete: true` the rule never fires.

## [0.2.0] — 2026-09-26

### Added

- **SSO auto-provisioning (Pro), opt-in.** `Settings → SSO → Let anyone from your
  domains sign in`. When somebody your identity provider authenticates has no
  Bullpane account and their email is in one of the listed domains, their first
  sign-in creates a password-less **viewer** account instead of being refused.
  Off by default; the pre-provisioned model is unchanged until an admin turns it on.
  - The domain list is mandatory: a Google OIDC client accepts every Google
    account, so the toggle cannot be switched on without at least one domain.
    Matching is exact (`example.com` does not admit `sub.example.com`).
  - OIDC tokens with `email_verified: false` are never provisioned.
  - Disabled accounts stay disabled; the role is always viewer, promote by hand.
  - New audit action `auth.sso_provisioned`, marked high risk, so the trail
    shows every account that arrived without an invite.
- `GET/PUT /api/sso/settings` now carries `autoProvision` and
  `autoProvisionDomains`; `PUT` accepts any subset of fields.

## [0.1.0] — 2026-09-13

The first published version. Everything before it was development, run for
months against a production Redis with millions of BullMQ jobs a day; this is
the point where the dashboard is worth other people's time.

### The free edition

Everything bull-board does, with no login at all: start the container, open it,
use it. No account, no first-run wizard, no `SESSION_SECRET`. The header says
"No login" where an account menu would be, and the server warns at boot when an
open instance is bound to all interfaces. Put it behind your reverse proxy or VPN.

- **Queues and jobs.** Every BullMQ state (waiting, active, delayed, prioritized,
  completed, failed, paused, waiting-children), per-minute completed/failed rates
  from BullMQ's own metrics counters, and an attention view for the queues that
  need you.
- **Job pages** with the data as a tree or raw JSON, options, return value, stack
  traces, logs, progress and parent/child links. Delayed jobs say when they will
  run, decoded from the delayed set's score so it is right after a backoff retry.
- **Flow tree per job.** A job that belongs to a flow has a page drawing the real
  parent/child instances, breadth-first from the root and bounded so a fan-out
  parent with 50k children returns the first slice, never 50k nodes.
- **Actions:** add, retry, promote, remove and discard a job, in bulk if you like;
  pause (with a reason, kept in the audit log), resume, clean, retry-all, drain
  and obliterate a queue, with the destructive ones behind the admin role and a
  confirmation.
- **Search inside job data**, bounded and resumable so a big state never blocks
  Redis.
- **Job schedulers** (repeatable jobs) per queue and across a whole connection,
  with next run, "next run within" windows and overdue highlighting.
- **BullMQ Pro groups.** Each group's status in Pro's own vocabulary (waiting,
  limited, maxed, paused), jobs waiting and how many are prioritized, active jobs
  against the group's concurrency cap, rate limit, and when a limited group
  returns to rotation. Group jobs are listed in the order Pro serves them.
- **Redis health monitor:** memory (as a percentage of `maxmemory` when set),
  CPU, commands per second, latency, clients and keys, sampled on the server and
  shared across tabs.
- **Command palette** (`⌘K` / `Ctrl+K`) over every queue on every connection,
  hidden queues, and a sidebar whose connection order is the same for everyone.
- **Read-only mode** (`BULLPANE_READ_ONLY=true`) that refuses every write, for
  pointing the dashboard at production before you trust it.
- **BullMQ 4, 5 and 6** on Redis, Redis Cluster and Valkey, plus BullMQ Pro.
  BullMQ 6 kept the Redis layout of 5, and the inspector's suite runs against
  6.3 workers. The BullMQ 6 PostgreSQL backend is not supported yet.

### Pro

One installation, unlimited users, USD 39/month or USD 390/year. A key turns the
login on without a restart; a lapsed key reopens the dashboard the same way.

- **Users and roles** (admin / operator / viewer), enforced on every API call.
  Users are disabled, never deleted, so the audit history keeps its names.
- **SSO** over OIDC and SAML 2.0, pre-provisioned only (the IdP proves identity,
  it does not create accounts), with an environment-level password escape hatch
  so a misconfigured provider cannot lock you out.
- **Alerts** to Slack or any webhook, per queue or per folder.
- **Folders** to group queues the way the team thinks about them.
- **Flows:** the connection-wide graph of which queue feeds which.
- **Audit log:** append-only, with actor, target, detail (a pause's reason, a
  bulk action's counts) and CSV export. Job payloads are never recorded.

### Performance, because that is the whole point

- No `KEYS`, no unbounded scans. One Lua round trip per read, pipelined per
  queue, every access touching keys of a single queue so Redis Cluster works.
- Payloads are truncated inside Redis. List reads check sizes first and skip
  fields above 32 KiB; search skips payloads above 256 KiB and stops a call after
  8 MiB, handing back a cursor. Measured on 1 MB payloads: a page of 200 jobs
  costs 7 ms of Redis time, a search 8 ms.
- Queue discovery is incremental and finds queues with a live worker at once
  from `CLIENT LIST`; a keyspace with millions of keys is covered over passes and
  the overview says when the list is still partial.
- Writes go through the official `bullmq` client. Bullpane never reimplements
  its Lua.

[0.1.0]: https://github.com/madmorett/bullpane/releases/tag/v0.1.0
