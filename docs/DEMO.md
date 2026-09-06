# The demo simulator

`apps/simulator` keeps a Redis looking like the queue backbone of a busy
mid-sized company so the dashboard always has something to show. It uses the
real `bullmq` library (`Queue`, `Worker`, `FlowProducer`, `QueueEvents`), so
everything it writes is exactly what a production app would write. The only
hand-made part is the BullMQ Pro group layout (see below).

```sh
pnpm demo                                   # full stack: app + mysql + redis + simulator
# or, against a Redis you already have running on :6379
BULL_PREFIX=bull SIM_RESET=true pnpm dev:simulator
```

Demo login: `demo@bullmq-visualizer.dev` / `demo1234`.

## Environment

| Variable | Default | Meaning |
|---|---|---|
| `REDIS_URL` | `redis://localhost:6379` | Where to write. `rediss://` enables TLS. |
| `BULL_PREFIX` | `bull` | BullMQ key prefix. Must match the connection you add in the dashboard. |
| `SIM_INTENSITY` | `1` | `0.2` (quiet) to `3` (hammering). Scales every producer's rate and burst size. |
| `SIM_RESET` | `false` | `true` deletes everything under `${BULL_PREFIX}:*` on boot, with `SCAN` + `UNLINK` (never `KEYS`, never `FLUSHALL`). |
| `SIM_SEED` | random | Seeds the fake-data generator for reproducible payloads. |

Every worker runs with `metrics: { maxDataPoints: 1440 }` so the per-minute
completed/failed charts have data, and every producer uses
`removeOnComplete: { count: 500 }` / `removeOnFail: { count: 1000 }` so Redis
stays around 20-40 MB no matter how long the demo runs.

Every 10 s the process prints one status line: `queue +added/ok completed/x failed`.

## Queues

### payments.charge
Steady ~2 jobs/s (scaled by intensity), 200-1500 ms each, `attempts: 3` with
exponential backoff. ~4% fail: `gateway_timeout` retries (so you see jobs
bounce through `delayed`), `card_declined` throws `UnrecoverableError` and
lands in `failed` immediately. 15% of jobs carry a `priority`. Payloads look
like a PSP charge: ids, tenant, customer email, amount in cents, card brand.

### payments.refund
One job every ~6 s. 20% are "partial refund of an already-refunded charge",
which fail all 3 attempts — a slow, steady source of permanent failures.

### payments.webhook-dispatch
Bursty: 100-300 jobs every 30 s (first burst at boot). 10% fail with
`HTTP 502 from customer endpoint` and retry; 2% fail for good with `HTTP 410`.
**Every ~4 minutes the worker is paused for 60 s** — two bursts pile up in
`waiting`, then it resumes and drains. This is the queue to create alerts on.

### notifications.email
High volume (~4 jobs/s), priorities 1-10 (`2fa-code` = 1, `password-reset` = 2).
8% of jobs embed a ~50-100 KB rendered HTML body: proof that the job list only
ships a truncated preview and that the job page can still show the whole thing.

### notifications.sms
Producer sends 8-20 jobs/s, the worker has `limiter: { max: 10, duration: 1000 }`.
`waiting` grows and shrinks visibly; the queue shows a rate-limit key.

### notifications.push
70% of jobs are delayed 5 s to 10 min (`delay` option). `delayed` is always
populated and you can promote jobs by hand.

### pipeline.ingest → pipeline.transform → pipeline.load
Real BullMQ flows via `FlowProducer`: a `pipeline.load` parent with 2-4
`pipeline.transform` children, each with 1-3 `pipeline.ingest` children.
Parents sit in `waiting-children`; children carry `parent: { id, queueKey }`,
which is what the Flow graph (Pro) samples to draw `ingest → transform → load`.
Ingest jobs report progress in steps of 25%.

### reports.daily
Two job schedulers (`upsertJobScheduler`, every 1 min and 5 min), one
legacy-style `repeat: { every: 60000 }` job, and one-off `custom-export` jobs
delayed 2-10 min. Progress is an object (`{ percent, stage }`), not a number.

### media.thumbnails
One job every ~2 s. Progress goes 0 → 100 over ~5 s with a log line per
variant. Return values are big (per-variant metadata blobs). 5% throw with a
~30-frame stack trace.

### pro.grouped-tenants (fake BullMQ Pro)
A plain bullmq queue that also gets a hand-written Pro group layout so the
Groups view has data without a `@taskforcesh/bullmq-pro` token:

- jobs are added with `opts.group = { id: "tenant-…" }` (core keeps unknown opts)
  and their hash gets a `gid` field;
- `groups` (zset of 12 tenant ids), `groups:<gid>` (list of waiting ids),
  `groups:active`, `groups:paused` (`tenant-wonka`), `groups:max`
  (`tenant-acme`), `groups:limit` (`tenant-hooli`), `groups-lid`.

Key names live in one place, `apps/simulator/src/lib/pro-groups.ts`, and
mirror `GROUP_KEY` in `packages/redis-inspector/src/keys.ts`. They reflect the
Pro layout as best understood; if Pro changes, fix both files together.
Lists churn (pop/push every few seconds) and are reconciled every 30 s.

### legacy.exports
Paused (`queue.pause()`), 40 waiting jobs, no worker. Shows the paused state
and gives you something safe to resume, clean or drain in the playground.

## Tweaking

- **Quieter / louder:** `SIM_INTENSITY=0.5` or `SIM_INTENSITY=2` (compose:
  `SIM_INTENSITY=2 pnpm demo`).
- **Only some scenarios:** comment out entries in `apps/simulator/src/index.ts`.
  Each scenario is one file under `src/scenarios/`.
- **Different failure rates / outage cadence:** constants at the top of each
  scenario (`OUTAGE_EVERY`, `OUTAGE_FOR`, the `R.chance(…)` calls).
- **Adding a queue:** copy `src/scenarios/media.ts`, register queue and worker
  through `ctx.register(...)` so shutdown closes them, count with `ctx.stats`.

Stop with Ctrl+C; the simulator closes every worker (waiting for active jobs),
queue and connection before exiting.
