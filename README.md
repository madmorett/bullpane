<div align="center">

# Bullpane

**A fast, self-hosted dashboard for [BullMQ](https://bullmq.io) and BullMQ Pro.**

[bullpane.com](https://bullpane.com) · [Documentation](docs/) · [Changelog](CHANGELOG.md) · [llms.txt](https://bullpane.com/llms.txt)

<img src="https://bullpane.com/shots/overview.jpg" alt="Bullpane overview: every queue of a connection with counts, rates and the ones that need attention" width="880">

</div>

---

Point it at the Redis your workers already use and get queues, jobs, failures,
progress, logs, flows and Pro groups in a UI that is pleasant to look at.

The free edition asks for nothing: no account, no login, no first-run wizard.
Start the container, open it, use it.

Works with BullMQ 4, 5 and 6 on Redis, Redis Cluster and Valkey, and with
BullMQ Pro. The BullMQ 6 PostgreSQL backend is not supported yet; if you run
it, [say so](mailto:hello@bullpane.com) and it moves up the list.

It exists because the alternatives make you choose. bull-board has a UI from
2016. Taskforce.sh is hosted, so your job payloads leave your network. Bullpane
runs in a single container next to your stack, is free for the core, and
USD 39/month (or 390/year) unlocks the team features for one installation with
unlimited users.

> [!WARNING]
> **The free edition has no authentication at all.** Anyone who can reach the
> URL can retry, promote and delete jobs — the dashboard says so in its own
> header. Keep it on a private network, or unlock login, roles and the audit
> log with Pro.

## Designed for production Redis

A dashboard that slows down the workload it watches is worse than no dashboard.
These rules are enforced in `packages/redis-inspector`, which owns every read of
your Redis:

1. **No `KEYS`, ever.** Discovery is a bounded `SCAN`, cached.
2. **One round trip per read.** Counts, pages and details are Lua scripts
   (`EVALSHA`); multi-queue reads are one pipeline.
3. **Truncate inside Redis.** Lists return `string.sub(data, 1, previewBytes)`,
   so a queue of 500 KB payloads renders as cheaply as a queue of tiny ones.
4. **Search is bounded and resumable.** At most N job hashes per call, a cursor
   comes back, the UI streams results in.
5. **Writes use the official `bullmq` library.** Retry, promote, remove and
   clean inherit BullMQ's atomic scripts and stay correct across versions.
6. **Cluster safe.** Each script touches keys of exactly one queue (one hash tag).
7. **Connections fail fast.** 5 s connect timeout, one retry, no offline queue —
   a dead Redis is a red badge, not a hung dashboard.

Measured command by command in [deploy/ecs/REDIS-SAFETY.md](deploy/ecs/REDIS-SAFETY.md),
and held to it by the harness in [docs/STRESS-TEST.md](docs/STRESS-TEST.md).

## Quick start

```sh
cp .env.example .env      # nothing to set for the free edition; SESSION_SECRET matters once Pro turns login on
docker compose up -d      # app on :3000 + MySQL (bring your own Redis)
```

1. Open <http://localhost:3000>. The free edition drops you straight into the
   dashboard — there is nothing to sign up for.
2. **Connections → Add**: Redis URL, BullMQ prefix (`bull` unless you changed
   it), cluster yes/no. Queues are discovered by scanning for `prefix:*:meta`,
   cached for 30 s.
3. That is it. Add more connections for staging/prod, or other prefixes.

Already have MySQL? Set `DATABASE_URL` and delete the `mysql` service from
`docker-compose.yml`. The image is one Node process: put it behind your reverse
proxy and set `PUBLIC_URL` so alert links point at the right host.

Read [docs/PRODUCTION-TRIAL.md](docs/PRODUCTION-TRIAL.md) before pointing it at
a busy production Redis, and [deploy/README.md](deploy/README.md) for EC2, ECS
Fargate and Compose.

## Run the demo

A throwaway Redis plus a simulator that behaves like a mid-sized company:

```sh
git clone https://github.com/madmorett/bullpane && cd bullpane
pnpm demo        # = docker compose -f docker-compose.demo.yml up --build
```

Open <http://localhost:3000> and log in with `demo@bullpane.com` / `demo1234`.

Payments with ~4% declines, a bursty webhook dispatcher whose worker "dies"
every four minutes, a rate-limited SMS queue, real BullMQ flows
(`ingest → transform → load`), delayed and repeatable reports, a paused legacy
queue and a fake BullMQ Pro grouped queue. Everything is unlocked (the demo runs
as Pro, which is why it has a login) and everything can be poked at — the
simulator refills it. Details in [docs/DEMO.md](docs/DEMO.md).

## Free vs Pro

| Capability | Free | Pro |
|---|---|---|
| Unlimited connections & queues | ✓ | ✓ |
| Job list / detail / progress / logs / search in data | ✓ | ✓ |
| Add · retry · promote · remove · clean · drain · pause | ✓ | ✓ |
| Bulk retry / promote / remove on a selection | ✓ | ✓ |
| BullMQ Pro groups & batches view | ✓ | ✓ |
| Per-minute completed/failed metrics | ✓ | ✓ |
| Login, users & roles (admin / operator / viewer) | – (open, no login) | ✓ |
| Alerts per queue or folder (waiting, failures, failure %) → Slack / webhook | – | ✓ |
| Folders to organise queues across connections | – | ✓ |
| Flow graph (detected from BullMQ flows + manual edges) | – | ✓ |
| Audit log: who did what, when, from which IP — persisted, filterable, CSV | – | ✓ |
| SSO (OIDC + SAML 2.0), configured by your own admin in the UI | – | ✓ |

USD 39/month or 390/year, one installation, unlimited users. Pro features are
**visible in the free edition with a lock icon, never hidden**. Gating lives in
exactly two places: `requireFeature()` on the server (HTTP 402) and
`useEdition()` on the web.

### The audit log, specifically

bull-board has no users at all, so it cannot tell you who did anything.
Taskforce is hosted, so the answer lives in someone else's account. If you run
queues for a regulated customer, "who drained the payments queue on the 14th,
and from which IP?" is a question you have to answer from your own database.

Every mutating call is recorded — jobs, queues, connections, users, license,
logins — with the actor, target, parameters, result and IP. Three choices make
it worth trusting:

- **Refused attempts are recorded too.** "Tried to obliterate and got a 403" is
  a finding. A success-only log shows silence in exactly the case you care about.
- **The job payload is never stored.** The log keeps the parameters of an action
  (`{ state: "completed", removed: 3412 }`) and, where useful, the payload size
  in bytes. Customer PII does not belong in a table you export as CSV.
- **Nothing can edit or delete a row.** There is no such endpoint. Rows leave
  only by age (`BULLPANE_AUDIT_RETENTION_DAYS`, default one year).

Recording happens in every edition; reading and exporting are Pro, because on a
single-admin install the log only ever says "it was me". Nothing is lost by
upgrading later — the history is already there.

## Pro license

Two kinds of key, both verified with Ed25519 against a public key compiled into
the server:

- **Subscription key** (`BULLPANE-XXXX-…`), bought on bullpane.com. Activated
  once against `api.bullpane.com`, which issues a signed 7-day lease that the
  server re-checks every 24 h. It keeps working for 7 days without contact, so a
  network blip is not an outage.
- **Offline key**, hand-signed for air-gapped installs and procurement. Verified
  locally, never talks to the internet.

Paste either in **Settings → License**, or set `BULLPANE_LICENSE_KEY`. The
signing and verification tooling (`scripts/gen-license.ts`) is in this
repository so the format is auditable. Full lifecycle, including what the server
sends on activation, is in [docs/PRO.md](docs/PRO.md).

## Local development

```sh
pnpm install
docker compose up mysql -d       # MySQL on localhost:3306 (bullpane/bullpane)
cp .env.example .env
pnpm dev                         # server :3000 (tsx watch) + web (Vite, proxied)
pnpm dev:simulator               # optional: fill local Redis with demo traffic
```

Useful: `pnpm typecheck`, `pnpm test`, `pnpm build`.

The simulator honours `REDIS_URL`, `BULL_PREFIX`, `SIM_INTENSITY` (0.2–3) and
`SIM_RESET=true` (wipes the prefix first, `SCAN`+`UNLINK` only). To test Pro
locally: `pnpm --filter @bullpane/server exec tsx scripts/print-dev-license.ts`.

See [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request.

## Project layout

```
apps/server/               Fastify API + serves the built web UI. MySQL, auth, alerts, licensing.
apps/web/                  React + Vite + Tailwind dashboard.
apps/simulator/            Demo traffic generator + the stress harness.
apps/website/              bullpane.com (static, Cloudflare Worker).
apps/license-api/          api.bullpane.com — activates keys, signs leases (Cloudflare Worker).
packages/shared/           Types + zod schemas. The contract between everything.
packages/redis-inspector/  ioredis + Lua. Every read of a customer's Redis goes here.
scripts/gen-license.ts     Ed25519 keypair + license signing (vendor side).
Dockerfile                 Multi-stage; targets `runner` (dashboard) and `simulator`.
docker-compose.yml         app + mysql (bring your own Redis).
docker-compose.demo.yml    app + mysql + redis + simulator, DEMO_MODE=true.
```

Start with [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) and
[docs/API.md](docs/API.md).

## Roadmap

- WebSocket live updates (today it polls; one `EVALSHA` per queue per refresh)
- Prometheus exporter for queue counts and failure rates
- Job data redaction rules (mask fields by path before they reach the browser)
- Audit log: per-action retention and a signed export for external auditors
- Queue-level retention policies (auto-clean completed/failed older than N)

## From the same author

Two small libraries for the same queues, dependency-free and MIT, built for the
same production that Bullpane watches:

- **[bullmq-outbox](https://github.com/madmorett/bullmq-outbox)** — when Redis is
  out of memory or unreachable, jobs land in a store you own instead of
  disappearing. Works with BullMQ v5, v6 and Pro.
- **[bullmq-fanout](https://github.com/madmorett/bullmq-fanout)** — turn BullMQ
  into a message bus: publish one domain event to many queues, each with its own
  worker, retries and failure domain. Works with BullMQ v5, v6 and Pro.

## License

MIT for the whole codebase — see [LICENSE](LICENSE). The Pro features are in
this repository under the same license; what you pay for is the key that unlocks
them in the shipped build, and the maintenance of the project. That gating is
the business model, and it is the honest reason this exists as open source at
all.

Security issues: please see [SECURITY.md](SECURITY.md) rather than opening a
public issue.
