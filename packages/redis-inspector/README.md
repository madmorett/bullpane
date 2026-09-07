# @bullpane/redis-inspector

Every read of a customer's Redis, and every write through the official `bullmq` API.
The server codes against `src/types.ts` (`Inspector`, `InspectorPool`); nothing else in
this package is a contract.

```
src/
├── types.ts        the public interface (do not rename members)
├── keys.ts         every BullMQ / BullMQ Pro key name, in one place
├── lua/*.lua       the read scripts (EVALSHA via ioredis defineCommand)
├── scripts.ts      loads lua/ from disk, registers them, typed call wrappers
├── parse.ts        job hash -> JobSummary / JobDetail (never throws on bad JSON)
├── connection.ts   URL -> ioredis client (fail-fast) and bullmq connection options
├── inspector.ts    RedisInspector
├── pool.ts         RedisInspectorPool (one inspector per connection id)
└── __tests__/      integration test against a throwaway redis-server on :6399
```

## Performance guarantees

These are the rules from `docs/ARCHITECTURE.md`, and where each one is enforced:

| Rule | Where |
|---|---|
| No `KEYS`, ever. Discovery is `SCAN MATCH ${prefix}:*:meta COUNT 500`, at most `maxScanIterations` iterations, cached `discoveryTtlMs` (30 s) | `inspector.ts` `scanQueues()` |
| One round trip per read. Counts, pages, detail, search, groups and flow sampling are Lua scripts | `lua/*.lua`, `scripts.ts` |
| Multi-queue counts are ONE pipeline of EVALSHA calls | `getQueueStats()` (cluster mode: parallel single calls, ioredis refuses multi-slot pipelines) |
| Payloads are truncated inside Redis (`string.sub(data, 1, previewBytes)`) | `getJobs.lua`, `searchJobs.lua` |
| Search inspects at most `maxScanPerCall` hashes per call and returns a cursor | `searchJobs.lua` |
| Writes use the official bullmq `Queue` / `Job` API | `inspector.ts` writes section |
| Cluster safe: each script touches keys of exactly one queue | every script; keys are built from `${prefix}:${queue}:` |
| Fail fast: `connectTimeout 5 s`, `maxRetriesPerRequest 1`, `enableOfflineQueue false`, background `retryStrategy` capped at 5 s | `connection.ts` `readClientOptions()` |
| Reads never mutate. The legacy `0:` wait-list marker is skipped, not popped; bullmq `Queue` instances are created with `skipMetasUpdate` | `queueStats.lua`, `getJobs.lua`, `getQueue()` |

## How the Lua scripts work

All scripts are read from `src/lua/` once per process (`fs.readFileSync`) and registered
on the ioredis client with `defineCommand`. ioredis sends `EVALSHA` and only falls back
to `EVAL` on `NOSCRIPT`, so the script body crosses the wire once per connection.

Field lists are passed as `ARGV` from `keys.ts` (`JOB_SUMMARY_FIELDS`), so the order the
Lua returns fields in is defined in exactly one place and `parse.ts` reads them back by
that same order.

| Script | KEYS | What it does |
|---|---|---|
| `queueStats.lua` | 8 state keys, `meta`, `groups`, `metrics:completed:data`, `metrics:failed:data` | `LLEN`/`ZCARD` per state, `HEXISTS meta paused`, `EXISTS groups` + `ZCARD groups`, optional last N metric points |
| `getJobs.lua` | one state (or Pro group) key | `LRANGE`/`ZRANGE`/`ZREVRANGE` for ids, then `HMGET` per id with `data`/`returnvalue` truncated. Ordering mirrors bullmq `getRanges`: lists are LPUSHed so `desc` = head first, `asc` reads from the tail |
| `searchJobs.lua` | one state key | Walks ids `[cursor, cursor+batch)` newest first, plain case-insensitive `string.find` over id, name, data, failedReason. Returns matches, next cursor (`-1` = exhausted), scanned, total |
| `getJob.lua` | hash, `:logs`, `:dependencies`, `:processed`, 8 state keys | `HGETALL`, last 100 logs, `LLEN`, `SCARD`, `HLEN`, and the state via `ZSCORE` (zsets) / `LPOS` (lists, `pcall`-guarded for Redis < 6.0.6 → `unknown`) |
| `sampleParents.lua` | N state keys (dynamic) | Newest N ids per state, `HMGET parentKey parent`, aggregates `parent.queueKey` counts in Lua |
| `getGroups.lua` | `groups`, `groups:active`, `groups:paused`, `groups:max`, `groups:limit` | `ZRANGE WITHSCORES`, `LLEN groups:${id}`, status from membership probed with `ZSCORE` then `SISMEMBER` (set vs zset is not documented) |

Job hash fields: `attemptsMade` is `atm` in newer bullmq; both are read. `parent` is JSON
`{ id, queueKey }`; `parentKey` (`${prefix}:${queue}:${id}`) is the fallback. `progress`
is a number or JSON. `stacktrace` is a JSON array. Bad JSON anywhere falls back to the
raw string instead of throwing.

## Adding a script

1. Create `src/lua/foo.lua`. Header comment: KEYS, ARGV, return shape, cost. Only touch
   keys derived from the one queue prefix you were given. No `KEYS`, no `SCAN`.
2. Add `foo: { numberOfKeys: <n>, readOnly: true }` to `SCRIPTS` in `scripts.ts`
   (`numberOfKeys: undefined` when the key count varies; then the first arg is the count).
3. Call it with `callScript(client, "foo", [...keys, ...argv])` or, inside a pipeline,
   `pipelineScript(pipeline, "foo", [...])`. Parse the reply with the `as*` helpers in
   `parse.ts`; never trust shapes coming back from Redis.
4. Cover it in `src/__tests__/inspector.test.ts` with data produced by bullmq itself.

## Writes

`getQueue()` lazily builds one bullmq `Queue` per queue name. Non-cluster: bullmq gets
connection options (with `url`) and owns its client. Cluster: bullmq only builds plain
`IORedis` from options, so it receives a `Redis.Cluster` instance we own and close.

`discardJob` moves an *active* job to failed by calling `job.discard()` (disables the
automatic retry) then `job.moveToFailed(err, "0")` — the `"0"` token makes bullmq's
`removeLock` skip the worker-lock check, which is what forcing a stuck job out needs.
Any other state throws `cannot_discard_job_in_state_<state>`.

## BullMQ Pro key layout (best knowledge, not documented upstream)

`groups` (zset id→score), `groups:${id}` (list of waiting job ids), `groups:active`,
`groups:paused`, `groups:max`, `groups:limit`, `groups-lid`. Job hashes carry `gid`
(we also accept `groupId` and `opts.group.id`). All of it lives in `keys.ts` `GROUP_KEY`
so a layout correction is a one-file change; `getGroups.lua` already tolerates set/zset
either way.

## Tests

```
pnpm --filter @bullpane/redis-inspector test
pnpm --filter @bullpane/redis-inspector typecheck
```

The test boots `redis-server --port 6399` (never the dev instance on 6379), creates real
queues with `Queue` / `Worker` / `FlowProducer`, hand-writes a fake Pro queue, runs the
whole read + write surface, and shuts the server down.
