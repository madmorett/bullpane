# @bullpane/server

Fastify 5 API that owns MySQL (users, sessions, connections, folders, alerts, flow edges,
settings), auth, licensing and the alert engine, and serves the built web UI. All reads of a
customer's Redis go through `@bullpane/redis-inspector`; this package never opens an
ioredis connection itself.

The route contract is `docs/API.md`; the DTOs and zod schemas come from
`@bullpane/shared` and are never redefined here.

## Run locally

```bash
# from the repo root
cp .env.example .env            # SESSION_SECRET is only needed once you unlock Pro
docker compose up mysql -d      # or any MySQL 8 reachable at DATABASE_URL
pnpm --filter @bullpane/server dev   # tsx watch, reads ../../.env
```

First boot waits for MySQL (retries for 60 s, one log line every 2 s), applies
`migrations/*.sql`, then listens on `http://localhost:3000`. Open the web UI (or
`POST /api/setup`) to create the first admin.

Playground: `DEMO_MODE=true` skips setup — it seeds the admin from
`DEMO_ADMIN_EMAIL`/`DEMO_ADMIN_PASSWORD`, a "Demo Redis" connection to `DEMO_REDIS_URL`,
three folders (Payments, Notifications, Data pipeline) mapped to the simulator's queues, and
two sample alerts. Pro is unlocked with a "demo" badge and mutating `/connections`, `/users`,
`/license` and `/setup` return `423 demo_locked`.

### Runtime: `tsx`, not `dist/`

Workspace packages are consumed as TypeScript source (`main: ./src/index.ts`) and the
inspector reads its Lua scripts from disk at runtime, so the pragmatic production runtime is
`tsx`:

| script | what it does |
|---|---|
| `pnpm dev` | `tsx watch src/index.ts` with `../../.env` |
| `pnpm start` | `tsx src/index.ts` (what the Dockerfile runs) |
| `pnpm build` | `tsc --noEmit` — a typecheck; nothing is emitted |
| `pnpm typecheck` | same |
| `pnpm test` | vitest unit tests (no MySQL / Redis needed) |
| `pnpm license:dev` | print a dev Pro license (see below) |

`tsconfig.build.json` is kept for anyone who wants a compiled `dist/` (`tsc -p tsconfig.build.json`),
but the compiled output still needs the workspace packages resolvable as source.

## Environment

Every variable in `/.env.example` is read in `src/config.ts`; nothing else touches `process.env`.

| Variable | Default | Notes |
|---|---|---|
| `PORT` | `3000` | |
| `HOST` | `0.0.0.0` | |
| `SESSION_SECRET` | random per process | Signs the `bullpane_session` cookie. Optional: the free edition has no login, so a first run must not be blocked by it. **Set a fixed 32+ character secret before unlocking Pro** — otherwise every restart logs everyone out. |
| `PUBLIC_URL` | `http://localhost:3000` | Used in Slack/webhook links (`/c/:connectionId/q/:queue`). `https://` makes the cookie `Secure`. |
| `DATABASE_URL` | `mysql://bullpane:bullpane@localhost:3306/bullpane` | |
| `BULLPANE_LICENSE_KEY` | empty | Pro license. A key saved via `PUT /api/license` (settings table) wins over the env var. |
| `BULLPANE_CHECKOUT_URL` | `https://bullpane.com/pro` | Target of the "Unlock Pro" button. |
| `DEMO_MODE` | `false` | See above. |
| `DEMO_REDIS_URL` | `redis://localhost:6379` | |
| `DEMO_ADMIN_EMAIL` | `demo@bullpane.com` | |
| `DEMO_ADMIN_PASSWORD` | `demo1234` | |
| `BULLPANE_QUEUE_DISCOVERY_TTL` | `30` | seconds the discovered queue list is cached per connection |
| `BULLPANE_ALERTS_INTERVAL` | `15` | seconds between alert evaluations |
| `BULLPANE_JOB_PREVIEW_BYTES` | `2048` | bytes of job `data` kept in list views |
| `WEB_DIST` | `../web/dist` (relative to `apps/server`) | Built UI. Served with an SPA fallback when the directory exists. |
| `LICENSE_PUBLIC_KEY_B64` | compiled-in key | DER/SPKI base64 Ed25519 public key override (development). |
| `LOG_LEVEL` | `info` | pino level |

## Licensing and the Pro edition

A license is `base64url(payloadJson).base64url(signature)`, Ed25519, verified offline against
the public key in `src/license.ts` (`LICENSE_PUBLIC_KEY_B64`). No phone-home.

Edition resolution (`src/services/edition.ts`), cached and invalidated by `PUT`/`DELETE /api/license`:

1. `DEMO_MODE=true` → `pro` with `demo: true`
2. valid key in the `settings` table (`license_key`) or `BULLPANE_LICENSE_KEY` → `pro`
3. otherwise `free` (all four features off; `GET /api/edition` still shows the price and checkout URL)

### Getting a dev Pro license

The compiled-in public key is a **development placeholder**. Its private half lives in
`/keys/dev-license-private.pem` (the `keys/` dir is gitignored; the public half is next to it as
`dev-license-public.pem`). To test Pro locally:

```bash
pnpm --filter @bullpane/server license:dev              # perpetual
pnpm --filter @bullpane/server license:dev -- --days 7  # expiring
BULLPANE_LICENSE_KEY='<printed key>' pnpm dev                         # or paste it in Settings → License
```

If `keys/` is missing (fresh clone), regenerate a pair and update the constant — the script prints
the exact command. Before shipping, replace the constant with the vendor public key from
`scripts/gen-license.ts` at the repo root.

## Auth and roles

Cookie session `bullpane_session`: httpOnly, `SameSite=Lax`, `Secure` when `PUBLIC_URL` is https,
signed by `@fastify/cookie`, 30-day expiry, random 32-byte id stored in `sessions`. Passwords are
bcrypt (10 rounds).

Guards are Fastify preHandlers, always in this order: `requireAuth` (401) → `requireFeature`
(402 `pro_required` with `feature`) → `requireRole` (403) → `blockInDemo` (423). The pro gate runs
before the role check on purpose: a viewer on the free edition sees the upsell, not "forbidden".

| Action | viewer | operator | admin |
|---|---|---|---|
| View queues, jobs, alerts, flows, folders | ✓ | ✓ | ✓ |
| Add / retry / promote / remove / discard jobs, pause / resume, clean, retry-all | – | ✓ | ✓ |
| Create / edit / delete alerts, folders, manual flow edges | – | ✓ | ✓ |
| Drain / obliterate a queue | – | – | ✓ |
| Manage connections, users, license | – | – | ✓ |

In the free edition there is exactly one user (the admin created by `/setup`); `/users` is a Pro
feature. Deleting yourself or the last admin returns `409 conflict`.

## Errors

One handler (`src/plugins/errors.ts`) turns anything thrown into
`{ error, message, feature?, details? }`. Zod failures become `400 validation` with
`details = error.flatten()`. Inspector calls are wrapped by `withRedis()`: connection failures
(`ECONNREFUSED`, timeouts, `NOAUTH`, "Connection is closed", ...) become `502 redis_unavailable`,
"missing key for job" becomes `404`, and BullMQ state complaints ("job is not in the failed state")
become `409 conflict`. Job data is never logged.

## Read-only mode

`BULLPANE_READ_ONLY=true` refuses every mutating request under `/api` with `423 read_only`,
enforced by one `onRequest` hook (`src/plugins/gates.ts`) rather than per route, so a new
route cannot forget it. `POST /api/auth/login` and `/logout` stay allowed. Use it when
pointing the dashboard at a production Redis for the first time. See
`../../docs/PRODUCTION-TRIAL.md`.

## How alerts evaluate

`src/alerts/engine.ts` ticks every `BULLPANE_ALERTS_INTERVAL` seconds, only while the edition has the
`alerts` feature. An alert is scoped to one **queue** or to a **folder** (every queue in the
folder, across connections; fires when any breaches, the worst queue is reported). Per tick, per
connection, it does **one** `discoverQueues + getQueueStats` call, shared by every alert that
touches that connection. Per queue:

| kind | measurement | breached when |
|---|---|---|
| `waiting_above` | `counts.waiting + paused + prioritized` from the shared stats | `> threshold` |
| `failed_above` | `getWindowCounts(queue, now - windowMinutes)` | `failed > threshold` |
| `failed_rate_above` | same window; `rate = failed / (failed + completed)` | `rate > percent`; skipped (state kept) when `failed + completed < minSample` |

`queueName: null` means "every discovered queue of the connection": each queue is measured and
the alert fires if **any** breaches; the worst queue is the one reported.

The state machine is the pure function `evaluateAlert(alert, sample, now)` in `src/alerts/evaluate.ts`:

* not firing + breached → **fire**: notify every channel, insert a `fired` event, set `firing`, `lastFiredAt = now`
* firing + breached → **renotify** only once `cooldownMinutes` have elapsed since `lastFiredAt`
* firing + healthy → **resolve**: notify, insert a `resolved` event, clear `firing`
* inconclusive sample (below `minSample`, or Redis unreachable for a queue alert) → nothing changes

Delivery (`src/alerts/deliver.ts`): Slack incoming webhooks get a Block Kit message (queue, value,
threshold, deep link); generic webhooks get
`POST { alert, event, connection, queue, value, threshold, status, message, url }` plus the custom
headers. 5 s timeout per channel via `AbortSignal.timeout`; a failed delivery is recorded as a
`delivery_failed` event. `POST /api/alerts/:id/test` sends a synthetic event and returns per-channel
results. Events older than 30 days are pruned.

## Flows

`GET /api/connections/:id/flows?sample=200` builds one node per discovered queue (counts from a
single `getQueueStats`), detected edges from `sampleFlowEdges` per queue (5 in parallel, cached
30 s per connection, id `d:<from>-><to>`), plus manual edges from `flow_edges`.

## Layout

```
src/
  config.ts            env → Config
  app.ts               buildApp(): fastify + services on app.ctx + static/SPA
  index.ts             boot: wait for MySQL, migrate, seed demo, listen, alerts engine, shutdown
  context.ts           AppContext + fastify type augmentation
  db/                  drizzle schema, mysql2 pool, sql migrator
  auth/                bcrypt, sessions, guards, session cookie plugin
  license.ts           Ed25519 verify/sign
  plugins/             errors (ApiError mapping), gates (pro feature / demo lock)
  services/            edition, connections, users, folders, alerts (CRUD), flows, inspector error mapping
  alerts/              evaluate (pure), deliver (slack/webhook), engine (interval loop)
  routes/              one file per resource, registered under /api
  demo/seed.ts         DEMO_MODE content
  __tests__/           vitest, no infrastructure needed
migrations/0001_init.sql
scripts/print-dev-license.ts
```
