# Stress test: does the dashboard degrade the queues it watches?

The one promise that matters for a tool you point at production: reading the
dashboard must not slow down the workers and producers using the same Redis.
This document records how we test that, what we found, and the numbers before
and after the fixes. Rerun it whenever a Lua script or the discovery changes.

## Method

Everything lives in `apps/simulator/src/stress/` and targets a **dedicated**
Redis (`STRESS_REDIS_URL`, default `redis://localhost:6390`; never the dev or
demo one). The Bullpane server under test runs in production mode
(`pnpm --filter @bullpane/server start`, tsx without watch).

| piece | what it does |
|---|---|
| `load.ts` | builds the fixture through the official bullmq API: `stress.backlog` (waiting, ~2 KB payloads), `stress.fat` (waiting, **1 MB** payloads), `stress.archive` (completed + ~13 % failed, produced by a real Worker) |
| `probe.ts` | the "operation": a producer doing ~185 `queue.add`/s on `stress.live` plus a Worker; records every add round trip and the queue latency (`processedOn − timestamp`) once a second |
| `redis-monitor.ts` | one `INFO` a second: ops/s, CPU, memory, plus new `SLOWLOG` entries (≥ 10 ms) and `LATENCY LATEST` |
| `dashboard-load.ts` | simulated users against the HTTP API: `idle` (1 user on Overview), `realistic` (5 users: overview, two queue pages polling every 3 s, job pages, alerts, health), `hostile` (N clients with **no** think time on the most expensive reads: 200 × 1 MB page, substring search, deep pages of a 1M zset, forced discovery) |
| `run-phases.sh` | baseline → 1 user → 5 users → hostile ×20 → hostile ×50 → recovery, 60 s each; then `report.ts` prints one row per phase |

```sh
redis-server --port 6390 --save "" --appendonly no --daemonize yes \
  --latency-monitor-threshold 10 --slowlog-log-slower-than 10000 --slowlog-max-len 2048
cd apps/simulator
STRESS_OUT=/tmp/bullpane-stress BACKLOG_JOBS=800000 FAT_JOBS=1500 ARCHIVE_JOBS=500000 pnpm exec tsx src/stress/load.ts
# start the server, log in, add redis://localhost:6390 as a connection, then:
#   echo COOKIE=<bullpane_session> > /tmp/bullpane-stress/cookie.txt
#   echo CID=<connection id>      > /tmp/bullpane-stress/cid.txt
STRESS_OUT=/tmp/bullpane-stress BASE=http://localhost:3100 bash src/stress/run-phases.sh
```

Fixture used for the numbers below: 1.3 M keys, 4.6 GB — 800 000 waiting × 2 KB,
1 500 waiting × 1 MB, 437 500 completed + 62 500 failed × 1 KB. Machine: Apple
M3 Pro, Redis 7.0.11. (A first attempt with 3.15 M keys / 10.4 GB pushed the
laptop into swap — 85 % of the dataset paged out — which inflated every number;
those runs were discarded. Check `used_memory_rss ≈ used_memory` before trusting a run.)

## What we found

Three defects, all in read paths that were assumed cheap.

1. **Discovery returned zero queues on a large keyspace.** `SCAN` ran a fixed
   200 iterations × COUNT 500 = 100 k keys and gave up. With 1.3 M keys the four
   `*:meta` hashes were never reached: the dashboard showed an empty queue list
   while every queue worked when addressed by URL.
2. **Job pages copied whole payloads into Lua before truncating them.** `HMGET
   data` on 200 jobs of 1 MB moved 200 MB through the script: **290 ms** of
   blocked Redis per page request (40 ms for a 25-row page).
3. **Search did the same, ×1000, plus `string.lower` and concatenation on 1 MB
   strings.** One call on `stress.fat` held Redis for **12.5–13.4 s**. Twenty
   hostile clients queued behind each other; the producer's `queue.add` stalled
   for the whole time (the probe recorded 0 adds/s for 53 of 55 seconds).

## Fixes

- Discovery is incremental: a pass spends at most `maxScanIterations` (2000, COUNT
  1000) / `discoveryScanBudgetMs` (1.5 s) and keeps its cursor, so any keyspace is
  eventually covered; queues with a connected worker are found immediately via
  `CLIENT LIST` names; known names are re-verified with `EXISTS`; a full re-scan
  runs every 5 min; `?refresh=1` is honoured at most every 5 s. The API exposes
  `discovery.complete` and the Overview says when a scan is still in progress.
- `getJobs.lua` checks `HSTRLEN` first and does not read `data` / `returnvalue`
  above `listFieldCapBytes` (32 KiB); the row carries `dataBytes` and the UI shows
  "payload 1.0 MB · open the job".
- `searchJobs.lua` skips `data` above `searchFieldCapBytes` (256 KiB, the job still
  matches on id / name / error and is counted in `skippedLargePayloads`), stops a
  call at `searchByteBudget` (8 MiB) and searches each field separately instead of
  concatenating a haystack.

## Numbers

Single request on an idle, RAM-resident Redis (HTTP round trip, warm):

| read | before | after |
|---|---|---|
| page of 25 / 200 jobs, 2 KB payloads | 6 / 8 ms | 5 / 9 ms |
| deep page (offset 700 k of 800 k) | – | 7 ms |
| page of 25 / 200 jobs, **1 MB** payloads | 40 / **290 ms** | 5 / **7 ms** |
| search, 1000 × 2 KB | 20 ms | 19 ms |
| search, 1000 × **1 MB** | **12 500 ms** | **8 ms** |
| discovery, 1.3 M keys | `[]` | 3 queues, `complete: true`, 0.7 s |

Probe (the producer / worker) per phase, after the fixes. `add` = `queue.add`
round trip; `qlat` = time a job waited before a worker took it:

| phase | adds/s | add p50 / p99 / max | done/s | qlat p99 | Redis CPU | slowest command |
|---|---|---|---|---|---|---|
| baseline, server idle | 183 | 0.45 / 1.7 / 14 ms | 183 | 1 ms | 10 % | 27 ms |
| 1 user on Overview | 183 | 0.52 / 1.6 / 25 ms | 183 | 1 ms | 13 % | 27 ms |
| 5 realistic users | 183 | 0.52 / 1.35 / 22 ms | 183 | 1 ms | 13 % | 20 ms |
| hostile ×20, no think time | 180 | 38 / 77 / 109 ms | 180 | 1.2 s | 99 % | 35 ms |
| hostile ×50 | 179 | 97 / 225 / 274 ms | 161 | 6.4 s | 98 % | 40 ms |
| recovery | 185 | 0.44 ms p50 at once | 224 | – | 14 % | – |

Before the fixes the hostile ×20 phase read: adds/s 73, add max **979 603 ms**,
slowest command **940 505 ms** (one `searchJobs` EVALSHA, swap included).
Server process: 143–193 MB RSS, ≤ 18 % CPU throughout.

Read this as: with real usage patterns the dashboard is invisible to the
workload (p99 unchanged, nothing above 27 ms). Under deliberate abuse no single
command blocks Redis for more than 40 ms any more; what remains is saturation
by request **volume** — 20–50 clients issuing ~230 k commands/s with zero
pause — which raises producer latency to tens or hundreds of ms while it lasts
and recovers instantly.

## Open recommendations

- **Per-connection read budget.** Nothing today stops a runaway client (or 50
  tabs) from taking most of a Redis core. A token bucket of Redis time per
  connection, or a small concurrency window for Lua reads, would bound the
  dashboard's share regardless of client count. Not implemented: it is a policy
  choice (what share is acceptable) more than a bug.
- `INFO` on a 3 M-key server measured 17 ms once (swap suspected); the health
  sampler is already rate-limited to one `INFO` per 2 s per connection.
