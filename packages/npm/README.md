# Bullpane

**A fast, self-hosted dashboard for [BullMQ](https://bullmq.io) and BullMQ Pro.**

```sh
npx bullpane --redis redis://localhost:6379
```

Open <http://localhost:3000>. That is the whole install: no database to set up, no account, no login.

<img src="https://bullpane.com/shots/overview.jpg" alt="Bullpane overview: every queue of a connection with counts, rates and the ones that need attention" width="880">

[bullpane.com](https://bullpane.com) · [Live demo](https://demo.bullpane.com) · [GitHub](https://github.com/madmorett/bullpane) · [Changelog](https://bullpane.com/changelog)

## What you get

- Every queue on a Redis, with counts, success rate and what needs attention.
- Jobs by state, search inside job data, job detail with data, return value, stack trace and logs.
- Retry, promote, remove and bulk actions through the official `bullmq` API. Pause, resume, clean, drain.
- Job schedulers, flows (parent/child trees), stalled jobs, Redis health.
- BullMQ Pro groups: per-group concurrency, rate limits and paused groups.
- Safe on a busy production Redis: no `KEYS`, one round trip per read, payloads truncated inside Redis.

Works with BullMQ 4, 5 and 6 on Redis, Redis Cluster and Valkey, and with BullMQ Pro.

**Pro** (USD 39/month, one installation, unlimited users) adds login with roles, SSO, alerts to Slack or webhooks, folders, a flow graph, an audit log and an MCP server for Claude and other AI clients.

## Options

```
npx bullpane [--redis <url>] [options]

  --redis <url>          Redis your BullMQ workers use, added as a connection
  --prefix <prefix>      BullMQ prefix of that connection (default: bull)
  --port <port>          HTTP port (default: 3000)
  --host <host>          Interface to listen on (default: 127.0.0.1)
  --data-dir <dir>       Where the SQLite database lives (default: ~/.bullpane)
  --database-url <url>   mysql://user:pass@host:3306/db to use MySQL instead
  --read-only            Refuse every write with 423
```

The free edition has no login, so it listens on `127.0.0.1` by default. Use `--host 0.0.0.0` only on a private network, or unlock Pro for login and roles.

Every environment variable of the Docker image works here too.

## Running it for a team

Use the Docker image, next to your stack:

```sh
docker run -d -p 3000:3000 -v bullpane-data:/data bullpane/bullpane
```

## Versus bull-board

bull-board is a middleware you mount in your app: a viewer, with no search inside job data, no roles and no alerts. Bullpane runs on its own, so it never ships with your app and can be put in front of production. A full comparison is at [bullpane.com/vs/bull-board](https://bullpane.com/vs/bull-board).

## License

Open core. The bundle contains the free core (MIT) and the Pro features, which are licensed under the Bullpane Commercial License (`LICENSE-ee`): readable, free for development and testing, a subscription for production. See `LICENSE`.
