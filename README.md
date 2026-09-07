# Bullpane

*Formerly BullMQ Visualizer. Website: [bullpane.com](https://bullpane.com).*

A fast, self-hosted dashboard for [BullMQ](https://bullmq.io) and BullMQ Pro.

You point it at the Redis your workers already use and get queues, jobs, failures,
progress, logs, flows and Pro groups in a UI that is pleasant to look at, behind a
real login. bull-board has no auth and a UI from 2016; Taskforce.sh is hosted, so
your job payloads leave your network, and the pricing page needs a translator. This
one runs in a single container next to your stack, is free for the core, and a
USD 19/month or 149/year unlocks the team features for one installation, unlimited users.

Designed for production Redis: no `KEYS`, one round trip per screen, payloads
truncated *inside* Redis before they travel. A dashboard that slows down the
workload it watches is worse than no dashboard.

## Free vs Pro

| Capability | Free | Pro (USD 19/mo or 149/yr) |
|---|---|---|
| Unlimited connections & queues | yes | yes |
| Job list / detail / progress / logs / search in data | yes | yes |
| Add · retry · promote · remove · clean · drain · pause | yes | yes |
| BullMQ Pro groups & batches view | yes | yes |
| Per-minute completed/failed metrics | yes | yes |
| Single admin login | yes | yes |
| Alerts per queue or per folder (waiting, failures, failure %) → Slack / webhook | – | yes |
| Users & roles (admin / operator / viewer) | – | yes |
| Folders to organise queues across connections | – | yes |
| Flow graph (detected from BullMQ flows + manual edges) | – | yes |
| **Audit log**: who paused / cleaned / drained what, when, from which IP — persisted, filterable, CSV export | – | yes |

Pro features are visible in the free edition with a lock icon, not hidden. The
license is a key from bullpane.com verified once a day against api.bullpane.com (7-day offline grace), or a hand-signed offline token for air-gapped installs. See
[docs/PRO.md](docs/PRO.md).

### The audit log, specifically

bull-board has no users at all, so it cannot tell you who did anything. Taskforce
is hosted, so the answer lives in someone else's account. If you run queues for a
regulated customer, "who drained the payments queue on the 14th, and from which
IP?" is a question you have to answer from your own database.

Every mutating call is recorded — jobs, queues, connections, users, license,
logins — with the actor, the target, the parameters, the result and the IP. Three
choices make it worth trusting:

* **Refused attempts are recorded too.** "Tried to obliterate and got a 403" is a
  finding. A success-only log shows silence in exactly the case you care about.
* **The job payload is never stored.** The log keeps the parameters of an action
  (`{ state: "completed", removed: 3412 }`) and, where useful, the payload size in
  bytes. Customer PII does not belong in a table you export as CSV.
* **Nothing can edit or delete a row.** There is no such endpoint. Rows leave only
  by age (`BULLPANE_AUDIT_RETENTION_DAYS`, default one year).

Recording happens in every edition; reading and exporting are Pro, because on a
single-admin install the log only ever says "it was me". Nothing is lost by
upgrading later — the history is already there.

## Try the live demo

```sh
git clone https://github.com/madmorett/bullpane && cd bullpane
pnpm demo        # = docker compose -f docker-compose.demo.yml up --build
```

Open <http://localhost:3000> and log in with `demo@bullpane.com` / `demo1234`.

The demo runs a throwaway Redis plus a simulator that behaves like a mid-sized
company: payments with ~4% declines, a bursty webhook dispatcher whose worker
"dies" every four minutes, a rate-limited SMS queue, real BullMQ flows
(`ingest → transform → load`), delayed and repeatable reports, a paused legacy
queue and a fake BullMQ Pro grouped queue. Everything is unlocked (Pro in demo
mode) and everything can be poked at; the simulator refills it. Details in
[docs/DEMO.md](docs/DEMO.md).

## Run it for real

```sh
cp .env.example .env      # set SESSION_SECRET to something long and random
docker compose up -d      # app on :3000 + MySQL (bring your own Redis)
```

1. Open <http://localhost:3000>. The first visit shows the setup screen: create
   the admin account.
2. **Connections → Add**: Redis URL, BullMQ prefix (`bull` unless you changed
   it), cluster yes/no. The dashboard discovers queues by scanning for
   `prefix:*:meta` and caches the list for 30 s.
3. That is it. Add more connections for staging/prod, or other prefixes.

Already have MySQL? Set `DATABASE_URL` and delete the `mysql` service from
`docker-compose.yml`. The image is one Node process; put it behind your
reverse proxy and set `PUBLIC_URL` so alert links point at the right host.

## Performance promise

Rules enforced in `packages/redis-inspector`, which owns every read of your Redis:

1. **No `KEYS`, ever.** Discovery is a bounded `SCAN`, cached.
2. **One round trip per read.** Counts, pages and details are Lua scripts
   (`EVALSHA`); multi-queue reads are one pipeline.
3. **Truncate inside Redis.** Lists return `string.sub(data, 1, previewBytes)`;
   a queue of 500 KB payloads renders as cheaply as a queue of tiny ones.
4. **Search is bounded and resumable.** At most N job hashes per call, cursor
   returned, UI streams results in.
5. **Writes use the official `bullmq` library.** Retry, promote, remove and
   clean inherit BullMQ's atomic scripts and stay correct across versions.
6. **Cluster safe.** Each script touches keys of exactly one queue (one hash tag).
7. **Connections fail fast.** 5 s connect timeout, one retry, no offline queue:
   a dead Redis is a red badge, not a hung dashboard.

## Local development

```sh
pnpm install
docker compose up mysql -d       # MySQL on localhost:3306 (bullpane/bullpane)
cp .env.example .env
pnpm dev                          # server :3000 (tsx watch) + web (Vite, proxied)
pnpm dev:simulator                # optional: fill your local Redis with demo traffic
```

Useful: `pnpm typecheck`, `pnpm test`, `pnpm build`.
The simulator honours `REDIS_URL`, `BULL_PREFIX`, `SIM_INTENSITY` (0.2-3) and
`SIM_RESET=true` (wipes the prefix first, SCAN+UNLINK only).

## Pro license

1. Buy at the checkout link shown on the "Unlock Pro" button (`BULLPANE_CHECKOUT_URL`).
2. Paste the key in **Settings → License**, or set `BULLPANE_LICENSE_KEY` in the
   environment.
3. Validation is offline against a public key compiled into the server. No
   network call, no telemetry, works air-gapped. Perpetual for 1.x.

Vendor tooling (`scripts/gen-license.ts`: keygen, sign, verify) is in the
repo so the format is auditable. See [docs/PRO.md](docs/PRO.md).

## Deploy

See [deploy/README.md](deploy/README.md) for EC2, ECS Fargate and Docker Compose,
and [docs/PRODUCTION-TRIAL.md](docs/PRODUCTION-TRIAL.md) before pointing it at a
busy production Redis.

## Project layout

```
apps/server/            Fastify API + serves the built web UI. MySQL, auth, alerts, licensing.
apps/web/               React + Vite + Tailwind dashboard.
apps/simulator/         Demo traffic generator (real bullmq + fake Pro group keys).
packages/shared/        Types + zod schemas. The contract between everything.
packages/redis-inspector/  ioredis + Lua. Every read of a customer's Redis goes here.
scripts/gen-license.ts  Ed25519 keypair + license signing (vendor side).
Dockerfile              Multi-stage; targets `runner` (dashboard) and `simulator`.
docker-compose.yml      app + mysql (bring your own Redis).
docker-compose.demo.yml app + mysql + redis + simulator, DEMO_MODE=true.
docs/                   ARCHITECTURE.md · API.md · DEMO.md · PRO.md
```

## Roadmap

- WebSocket live updates (v1 polls; one `EVALSHA` per queue per refresh)
- Prometheus exporter for queue counts and failure rates
- Job data redaction rules (mask fields by path before they reach the browser)
- Audit log: per-action retention and a signed export for external auditors
- SSO (OIDC) for the Pro edition
- Queue-level retention policies (auto-clean completed/failed older than N)

## License

MIT for the whole codebase, see [LICENSE](LICENSE). The Pro features are in
this repository under the same license; what you pay for is the key that
unlocks them in the shipped build and the maintenance of the project. That
gating is the business model, and it is the honest reason this exists as
open source at all.
# bullpane
