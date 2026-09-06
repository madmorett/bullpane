--[[
  What Redis knows about how ONE queue is configured. Single round trip.

  KEYS[1]  meta hash            (version, paused, concurrency, max, duration, opts.maxLenEvents)
  KEYS[2]  limiter key          (exists with a TTL while a worker rate limiter is throttling)
  KEYS[3]  Pro `groups` zset
  KEYS[4]  Pro `groups:active`
  KEYS[5]  Pro `groups:paused`
  KEYS[6]  Pro `groups:max`     (exists => per-group concurrency limits configured)
  KEYS[7]  Pro `groups:limit`   (exists => per-group rate limits configured)
  KEYS[8]  metrics:completed hash (exists => the worker collects metrics)

  Returns:
    [1] HGETALL meta (flat field/value array)
    [2] PTTL limiter (-2 when the key does not exist)
    [3] EXISTS groups, [4] ZCARD groups
    [5] cardinality of groups:active (ZCARD, falling back to SCARD)
    [6] cardinality of groups:paused
    [7] EXISTS groups:max, [8] EXISTS groups:limit
    [9] EXISTS metrics:completed

  Everything here is O(1) except HGETALL on the tiny meta hash. Cluster safe: one queue.
  Worker-side options (worker concurrency, batch size) are NOT in Redis; the caller
  reports them as unknown instead of guessing.
]]
local rcall = redis.call

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
out[3] = rcall("EXISTS", KEYS[3])
out[4] = out[3] == 1 and rcall("ZCARD", KEYS[3]) or 0
out[5] = card(KEYS[4])
out[6] = card(KEYS[5])
out[7] = rcall("EXISTS", KEYS[6])
out[8] = rcall("EXISTS", KEYS[7])
out[9] = rcall("EXISTS", KEYS[8])
return out
