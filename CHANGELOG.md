# Changelog

Every user-visible change to Bullpane. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[semantic versioning](https://semver.org/).

Docker images are published per tag: `ghcr.io/<owner>/bullpane:0.0.1`, `:0.0`,
`:latest`, plus `:edge` for every push to `main`.

The public page at [bullpane.com/changelog](https://bullpane.com/changelog) is
written from this file — when you add an entry here, mirror it there
(`apps/website/public/changelog.html`).

## [0.0.1] — 2026-09-08

Everything below is the first tagged version. The releases before it were
development milestones and were not published; this is the baseline.

### Added

- **Per-group settings in the BullMQ Pro groups view.** Each group now shows its
  status in Pro's own vocabulary (waiting, limited, maxed, paused), jobs waiting
  and how many of them are prioritized, active jobs against the group's
  concurrency cap, its rate limit, and when a rate-limited group returns to
  rotation. A strip above the table counts the groups in each status.
- **Group jobs are listed in the order Pro serves them:** the group's list first,
  then its prioritized jobs.
- **`Settings → SSO`:** OIDC and SAML single sign-on (Pro), with an env-level
  password escape hatch so a misconfigured identity provider cannot lock an
  installation out of itself.
- **Payload sizes in job lists.** A job whose payload is too large to preview
  shows its size and links to the job page instead of an empty cell.
- **Discovery progress.** On a Redis with millions of keys the queue list can
  take a few scan passes to complete; the Overview now says so instead of letting
  a partial list read as the whole truth.
- One line per connection in the Redis health strip.

### Changed

- **Queue discovery is incremental and finds queues with a live worker
  immediately.** The `SCAN` keeps its cursor between passes, so any keyspace is
  eventually covered, and queues whose workers are connected are listed at once
  from `CLIENT LIST`. Deleted queues disappear on the next pass.
- **Large payloads no longer set the cost of a page or a search.** List reads
  check the size first and skip fields above 32 KiB; search skips payloads above
  256 KiB (the job still matches on id, name and error) and stops a call after
  8 MiB of payload, handing back a cursor. Measured on 1 MB payloads: a page of
  200 jobs went from 290 ms of Redis time to 7 ms, and a search from 12.5 s to
  8 ms.
- The queue setup panel reports group settings as counts per status and how many
  groups carry a per-group override, replacing two yes/no flags.
- Session cookie renamed to `bullpane_session`.
- Store moved from Polar to Creem (Polar does not pay out in Brazil).

### Fixed

- **BullMQ Pro queues showed no groups at all.** The reader assumed a key layout
  that BullMQ Pro does not use. Verified against `@taskforcesh/bullmq-pro`
  7.48.0 with real workers: a group lives in exactly one of four status sets, so
  a queue whose groups were all at their concurrency cap looked empty, and Pro
  detection missed it entirely.
- **Group settings hashes appeared as phantom queues** in the sidebar and the
  queue search (`orders:groups:tenant-a`).
- Waiting counts for a Pro group ignored prioritized jobs.

### Also in 0.0.1 — the dashboard itself

- **Queues and jobs.** Every BullMQ state (waiting, active, delayed, prioritized,
  completed, failed, paused, waiting-children), per-minute completed/failed rates
  from BullMQ's own metrics counters, and an attention view for the queues that
  need you.
- **Job pages** with the data as a tree or raw JSON, options, return value, stack
  traces, logs, progress and parent/child links.
- **Actions:** add, retry, promote, remove and discard a job, in bulk if you
  like; pause, resume, clean, retry-all, drain and obliterate a queue, with the
  destructive ones behind the admin role.
- **Search inside job data**, bounded and resumable so a big state never blocks
  Redis.
- **Job schedulers** (repeatable jobs) listed with their pattern, run count and
  next run.
- **Redis health monitor:** memory, CPU, commands per second, latency, clients
  and keys, sampled on the server and shared across tabs.
- **Command palette** (`⌘K` / `Ctrl+K`) over every queue on every connection.
- **Pro:** alerts to Slack or any webhook, users and roles (admin / operator /
  viewer), folders, the flow graph, and an append-only audit log with CSV export.
- **Read-only mode** (`BULLPANE_READ_ONLY=true`) that refuses every write, for
  pointing the dashboard at production before you trust it.

[Unreleased]: https://github.com/madmorett/bullpane/compare/v0.0.1...HEAD
[0.0.1]: https://github.com/madmorett/bullpane/releases/tag/v0.0.1
