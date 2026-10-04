# Bullpane — self-hosted dashboard for BullMQ and BullMQ Pro

```sh
docker run -d -p 3000:3000 -v bullpane-data:/data bullpane/bullpane
```

Open <http://localhost:3000> and add the Redis your BullMQ workers use. No database to set up (SQLite in `/data`), no account, no login on the free edition.

![Bullpane overview](https://bullpane.com/shots/overview.jpg)

[bullpane.com](https://bullpane.com) · [Live demo](https://demo.bullpane.com) · [GitHub](https://github.com/madmorett/bullpane) · [Changelog](https://bullpane.com/changelog)

## What you get

- Every queue on a Redis with counts, success rate and what needs attention.
- Jobs by state, search inside job data, job detail with data, return value, stack trace and logs.
- Retry, promote, remove and bulk actions through the official `bullmq` API. Pause, resume, clean, drain.
- Job schedulers, flows (parent/child trees), stalled jobs, Redis health.
- BullMQ Pro groups: per-group concurrency, rate limits, paused groups.
- Safe on a busy production Redis: no `KEYS`, one round trip per read, payloads truncated inside Redis.

Works with BullMQ 4, 5 and 6 on Redis, Redis Cluster and Valkey, and with BullMQ Pro. A bull-board alternative that runs on its own instead of inside your app.

**Pro** (USD 39/month, one installation, unlimited users): login with roles, SSO, alerts to Slack or webhooks, folders, flow graph, audit log, and an MCP server for Claude and other AI clients.

## Configuration

| Variable | Default | |
|---|---|---|
| `DATABASE_URL` | unset → SQLite in `/data` | `mysql://user:pass@host:3306/db` for MySQL (needed for more than one replica) |
| `BULLPANE_CONNECTIONS` | empty | JSON array of Redis connections created at boot |
| `BULLPANE_READ_ONLY` | `false` | refuse every write with 423, for a first look at production |
| `SESSION_SECRET` | random | set 32+ characters before unlocking Pro |
| `PUBLIC_URL` | `http://localhost:3000` | used in alert links |
| `BULLPANE_LICENSE_KEY` | empty | Pro key; can also be pasted in Settings → License |

All variables: [apps/server/README.md](https://github.com/madmorett/bullpane/blob/main/apps/server/README.md).

## Tags

`latest`, `0.5.1`, `0.5` for releases, `edge` for every push to main. `linux/amd64` and `linux/arm64`.

Also published at `ghcr.io/madmorett/bullpane`, and on npm: `npx bullpane --redis redis://localhost:6379` runs it without Docker.
