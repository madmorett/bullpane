# Can this break my production Redis?

Short answer: the risk is real, and you can drive it to practically zero with two
layers that **do not depend on Bullpane's code being correct**. Below is what was
actually measured, not what the design intends.

---

## Layer 1 — a read-only Redis user (the one that matters)

The strongest protection is not a flag in the dashboard, it is **Redis refusing**.
Create a user that physically cannot write:

```bash
redis-cli ACL SETUSER bullpane on '>STRONG_PASSWORD' '~*' '&*' \
  -@all +@read +@scripting -@dangerous -keys -sort \
  +info '+client|list' +ping +echo +hello +auth
```

**The order matters.** On Redis 7, `INFO` belongs to `@dangerous`; if `-@dangerous`
comes after `+info` it cancels it and the health monitor stops working. That was
found by testing, not by reading the docs.

Verified against a real Redis 7.0.11:

```
DEL          -> NOPERM this user has no permissions to run the 'del' command
SET          -> NOPERM ...
LPUSH        -> NOPERM ...
ZADD         -> NOPERM ...
FLUSHALL     -> NOPERM ...
KEYS *       -> NOPERM ...
```

And the dashboard **works in full** with that user. Tested against 13 queues with
real data:

```
ok  connection status green        redis 7.0.11 · 0.6ms
ok  Redis health monitor           mem=7.71M cpuSec=2.25 clients=42 evicted=0
ok  queues + metrics               13 queues, 12 reporting metrics
ok  setup shows workers            lib=bullmq:5.81.4 workers=1
ok  job list / job detail / search inside job data
```

And when asking the dashboard to write:

```
add job  -> HTTP 409  NOPERM this user has no permissions...
pause    -> HTTP 409  NOPERM this user has no permissions...
```

Redis refused on its own. It never even had to rely on `BULLPANE_READ_ONLY`.

> Known wart: the error message names the `info` command even on a write attempt,
> because the `bullmq` library calls `INFO` before writing. The block is correct,
> the text is confusing. Worth fixing.

If your Redis predates 6 and has no ACL support, use a **read replica**: point the
dashboard at it and writes are impossible by definition.

---

## Layer 2 — `BULLPANE_READ_ONLY=true`

Already `true` in the task definition. It refuses every write request with HTTP 423
before the handler runs, in a single hook, so a new route cannot forget it. Tested:
14 write routes blocked.

This is the safety net against somebody clicking something, not against a bug in
Bullpane. Layer 1 is the one that covers that.

---

## What about the load? (the legitimate fear at 10M jobs/day)

Every command the dashboard runs against your Redis:

```
ZCARD · ZCOUNT · ZRANGE · ZREVRANGE · LLEN · LRANGE · LINDEX · LPOS
HGETALL · HMGET · HGET · HEXISTS · EXISTS · ZSCORE · SISMEMBER · PTTL · HSTRLEN
SCAN · INFO · CLIENT LIST · PING · EVALSHA
```

No `KEYS`. No `DEL`. No `FLUSHALL`. Nothing O(N) over the keyspace.

Per refresh cycle, per connection:

| What | Cost |
|---|---|
| Queue list (5s) | 1 pipeline, 1 EVALSHA per queue |
| Queue page (3s) | 1 EVALSHA for the counts, 1 for the visible page |
| Discovery (30s) | 1 bounded SCAN pass, `MATCH prefix:*:meta COUNT 500` |
| Health monitor (3s) | 1 INFO, which is O(1) |

Success counts use `ZCOUNT`, which is O(log N): it costs the same on a queue of 100
jobs and one of 21 million. Payloads are truncated **inside Lua**, and fields above
a cap are not read at all (`HSTRLEN` first, which is O(1)), so a queue of 1 MB jobs
costs the same as a queue of tiny ones. See `docs/STRESS-TEST.md` for the numbers
under a deliberately hostile load.

**Take a "before" snapshot** and compare — that is what settles the argument:

```bash
redis-cli -h your-cluster info stats | grep instantaneous_ops_per_sec
redis-cli -h your-cluster --latency -i 5
```

Open the dashboard on your busiest queue and compare. If the needle moves, the
**Pause monitoring** button on the home page cuts the dashboard's traffic instantly.

---

## What about the database?

If reusing your production database cluster makes you uncomfortable, that is a
reasonable instinct. Two observations:

1. What the dashboard writes is **304 KB**, measured on a real instance with
   queues, users, folders and alerts configured. It never touches anything that
   already exists: it creates its own tables in its own database (`bullpane`).
2. Even so, **if it makes you uncomfortable, do not reuse it**. A separate
   `db.t4g.micro` costs ~USD 15/month and ends the discussion. Optimising USD 15
   on a cluster you are nervous about is the wrong optimisation.

If you do reuse it, create a MySQL user with permission on the **`bullpane`
database only**:

```sql
CREATE DATABASE bullpane CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER 'bullpane'@'%' IDENTIFIED BY 'STRONG_PASSWORD';
GRANT ALL PRIVILEGES ON bullpane.* TO 'bullpane'@'%';   -- this database only
```

That way, even with a bug in Bullpane, the blast radius is a 304 KB database.

---

## Recommended order

1. Read-only Redis user (or a replica).
2. `BULLPANE_READ_ONLY=true`.
3. MySQL user restricted to the `bullpane` database.
4. Run it for a few days and compare your Redis metrics against the "before" snapshot.
5. Only then, if you want writes, switch to a Redis user with permission and
   `BULLPANE_READ_ONLY=false`. One step at a time.

Through steps 1 to 4 the worst case is that the dashboard does not work. There is no
path to data loss, because neither Redis nor MySQL will accept a write from it.
