# Pointing this at a production Redis

Written for the first real trial: a busy Redis (millions of jobs/day) and a dashboard you do
not trust yet. The goal is to learn whether it is accurate and cheap to run, without any
chance of touching a job.

## 1. Start read-only

```bash
BMV_READ_ONLY=true
```

Every non-GET request under `/api` is refused with `423 read_only` before it reaches a handler
(one hook, `apps/server/src/plugins/gates.ts`), so no forgotten route can write. Login and
logout still work. The UI still shows the buttons; they fail loudly instead of silently.

Turn it off only after you have watched the numbers for a few days.

## 2. Use a read-only Redis user (defence in depth)

The dashboard's reads are all `SCAN`, `LLEN`, `ZCARD`, `ZCOUNT`, `ZRANGE`, `LRANGE`, `HGETALL`,
`HMGET`, `PTTL`, `EXISTS`, `INFO`, `CLIENT LIST` plus `EVALSHA` of the read-only scripts.
On Redis 6+ create a user that can do exactly that:

```
ACL SETUSER bmv on >a-long-password ~* &* +@read +@scripting +info +client|list -@write -@dangerous
```

`+@scripting` is required for `EVALSHA`; the scripts are declared `readOnly` so a
`no-writes` ACL still runs them. If your Redis is older than 6, use read-only replicas instead
(point `BMV` at a replica and the dashboard works unchanged, minus writes).

## 3. Watch what it costs — from inside the dashboard

The homepage has a **Redis health monitor** at the top, one card per connection, polling
`GET /api/health/connections` every 3 s. It exists precisely for this trial: to prove the
dashboard is not hurting the Redis it is watching.

What each card shows, live, with sparklines:

| Tile | What it means | When to worry |
|---|---|---|
| Memory | `used_memory` + % of `maxmemory` | > 75% warns, > 90% is critical (worse with `noeviction`) |
| CPU | cores burned by the Redis process | a sustained rise the moment you connect the dashboard |
| Commands/sec | derived from `total_commands_processed` | compare before/after connecting |
| Latency | the INFO round trip | > 250 ms is flagged |
| Clients | connected, and how many are blocked | blocked is normal: BullMQ workers wait on `BRPOPLPUSH` |
| Keys | total keys across databases | |

Under "Details": RSS, peak memory, fragmentation ratio, maxmemory policy, keyspace hit rate,
evicted keys, expired keys, rejected connections, replicas, persistence status.

Warnings are computed on the server so every viewer sees the same thing. `eviction` on a queue
Redis is treated as critical: an evicted key is a lost job.

**Rates are derived server-side** by diffing consecutive INFO samples, so ten open browser
tabs still cost one INFO per 3 s. The first sample after startup shows no rate (there is
nothing to diff yet), and a Redis restart shows no rate rather than a negative one.

**"Pause monitoring"** on the panel stops the dashboard's own polling instantly. If production
looks unhappy, hit it first, then investigate.

### The baseline that actually proves it

Take these numbers BEFORE connecting the dashboard, then again with it open on your busiest
queue. That is the evidence you will want when you tell your team it is safe:

```bash
redis-cli info stats | grep instantaneous_ops_per_sec
redis-cli info cpu
redis-cli --latency -i 5
```

## 4. Watch it from outside too

A dashboard is only allowed to be boring. Before and during the trial:

```bash
redis-cli info commandstats | grep -E "evalsha|scan|zcount|hgetall"
redis-cli --latency-history -i 10
redis-cli info clients
```

What to expect per refresh cycle, per connection:
- sidebar/queues poll (every 5 s): one pipeline, one `EVALSHA` per queue
- queue page (every 3 s): one `EVALSHA` for counts, one for the visible job page
- discovery: one bounded `SCAN` pass at most every 30 s (`BMV_QUEUE_DISCOVERY_TTL`)
- setup panel: one `EVALSHA` + one `CLIENT LIST` per queue, cached 10 s

Knobs if you want it quieter: raise `BMV_QUEUE_DISCOVERY_TTL`, lower `BMV_JOB_PREVIEW_BYTES`,
raise `BMV_ALERTS_INTERVAL`, and use a `queueFilter` on the connection so it only discovers
the queues you care about.

`CLIENT LIST` is O(number of clients). If you run thousands of clients, that call is the one to
watch; it only happens when a queue page is open.

## 5. Things to verify against your own system

Tick these off before you sell it:

- [ ] Every queue you expect is discovered (compare with your own list; check the prefix).
- [ ] Counts match `bullmq`'s own `getJobCounts()` for a few queues.
- [ ] Job data search finds a job you know exists, and the "scanned X of Y" number is honest.
- [ ] A queue with very large payloads renders fast (previews are truncated at 2 KB).
- [ ] Repeatable/delayed jobs look right.
- [ ] Flow parents/children link correctly.
- [ ] BullMQ Pro: groups appear, counts match, group filter works. **This is the least tested
      part** — the Pro key layout was inferred without a Pro licence.
- [ ] Redis latency and CPU are unchanged with the dashboard open on the busiest queue.
- [ ] Alerts fire when you expect (set a low threshold on a quiet queue and watch Slack).

## 6. Then loosen up

Order to relax, one step at a time:
1. `BMV_READ_ONLY=false` but only give people `viewer` roles.
2. Give one person `operator` (retry/remove/pause) on a non-critical queue.
3. Keep `admin` (drain/obliterate/connections/users) to yourself.

Obliterate and drain are irreversible and behind `admin` plus a typed confirmation. They delete
jobs. Treat them as you would `FLUSHDB`.

## 7. Deployment shape for an internal trial

Run it next to your infra, not exposed to the internet:

```yaml
# docker-compose.trial.yml
services:
  app:
    image: bullmq-visualizer:local
    environment:
      BMV_READ_ONLY: "true"
      DATABASE_URL: mysql://bmv:bmv@mysql:3306/bmv
      SESSION_SECRET: <32+ random chars>
      PUBLIC_URL: https://queues.internal.example.com
      LOG_LEVEL: info
    ports: ["3000:3000"]
```

Put it behind your VPN or an authenticating proxy. The dashboard has its own login, but a
queue dashboard is a map of your business: do not put it on a public IP during a trial.
