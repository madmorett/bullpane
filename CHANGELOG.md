# Changelog

Every user-visible change to Bullpane. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[semantic versioning](https://semver.org/).

Docker images are published per tag: `ghcr.io/<owner>/bullpane:0.1.0`, `:0.1`,
`:latest`, plus `:edge` for every push to `main`.

The public page at [bullpane.com/changelog](https://bullpane.com/changelog) is
written from this file — when you add an entry here, mirror it there
(`apps/website/public/changelog.html`).

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
