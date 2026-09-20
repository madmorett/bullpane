--[[
  What Redis knows about how ONE queue is configured, in a single round trip.

  KEYS[1]  meta hash
  KEYS[2]  `limiter` (worker rate limiter; PTTL > 0 => throttling right now)
  KEYS[3]  Pro `groups`               zset, status "waiting"
  KEYS[4]  Pro `groups:limit`         zset, status "limited"
  KEYS[5]  Pro `groups:max`           zset, status "maxed"
  KEYS[6]  Pro `groups:paused`        zset, status "paused"
  KEYS[7]  Pro `groups:active:count`  hash  gid -> active jobs (only when the worker sets group.concurrency)
  KEYS[8]  Pro `groups:metas`         zset  gids with per-group overrides (concurrency / rate limit)
  KEYS[9]  metrics:completed hash (exists => the worker collects metrics)

  Returns:
    [1] HGETALL meta (flat field/value array)
    [2] PTTL limiter (-2 when the key does not exist)
    [3..6] ZCARD of the four status zsets (waiting, limited, maxed, paused)
    [7] HLEN groups:active:count
    [8] ZCARD groups:metas
    [9] EXISTS metrics:completed

  Everything here is O(1) except HGETALL on the tiny meta hash. Cluster safe: one queue.
  Worker-side options (worker concurrency, batch size) are NOT in Redis; the caller
  reports them as unknown instead of guessing.
]]
local rcall = redis.call

-- A layout change in Pro must degrade to 0, never to a WRONGTYPE error.
local function card(key)
  local ok, n = pcall(rcall, "ZCARD", key)
  if ok then return n end
  local ok2, m = pcall(rcall, "SCARD", key)
  if ok2 then return m end
  return 0
end

local out = {}
out[1] = rcall("HGETALL", KEYS[1])
out[2] = rcall("PTTL", KEYS[2])
out[3] = card(KEYS[3])
out[4] = card(KEYS[4])
out[5] = card(KEYS[5])
out[6] = card(KEYS[6])
out[7] = rcall("HLEN", KEYS[7])
out[8] = card(KEYS[8])
out[9] = rcall("EXISTS", KEYS[9])
return out
