--[[
  Counts + flags for ONE queue in a single round trip.

  KEYS[1..8]  state keys in STATE_ORDER:
              wait, active, completed, failed, delayed, prioritized, paused, waiting-children
  KEYS[9]     meta hash
  KEYS[10]    Pro `groups` zset
  KEYS[11]    metrics:completed:data list
  KEYS[12]    metrics:failed:data list
  KEYS[13]    metrics:completed hash  (field `count`, cumulative since forever)
  KEYS[14]    metrics:failed hash
  KEYS[15]    `repeat` zset (job schedulers)
  KEYS[16]    `stalled` SET (ids marked as stalled by the StalledCheck)

  ARGV[1]     withMetrics "1" | "0"
  ARGV[2]     number of metric points (newest N minutes)
  ARGV[3]     window start (unix ms) for the success/failure rate ZCOUNTs
  ARGV[4]     `${prefix}:${queue}:` (to read a job's opts and detect retention)

  Returns a flat array:
    [1..8]  counts (LLEN for lists, ZCARD for zsets)
    [9]     1 when the queue is paused (meta.paused exists)
    [10]    1 when the queue shows a BullMQ Pro signal (any group status zset,
            groups:metas, or meta.version "bullmq-pro:x")
    [11]    groups with jobs = sum of the four status zsets (see keys.ts)
    [12]    completed metric points, newest first (empty when withMetrics = 0)
    [13]    failed metric points, newest first
    [14]    ZCOUNT completed since ARGV[3]  (scores are finishedOn timestamps; O(log N))
    [15]    ZCOUNT failed since ARGV[3]
    [16]    meta.version ("bullmq:5.x" / "bullmq-pro:7.x") or false
    [17]    `opts` of the newest job in completed, or false. Only used to find out
            whether the queue uses removeOnComplete: with aggressive retention the
            zset counts lie, and the caller has to warn the user.
    [20]    ZCARD `repeat` — how many job schedulers the queue has. A ZCARD is O(1),
            so it fits here and the Schedulers tab badge costs no extra round trip.
    [21]    SCARD `stalled` — jobs that lost their lock. Cost: ONE more O(1) command
            in the same EVALSHA (no extra round trip to Redis). Worth the budget
            because it is the only way for the `active` tab to say "3 of these hung";
            without it the operator sees "active 8" and cannot tell half are dead.

  Cluster safe: every key belongs to the same queue (same hash tag).
  Read only: the legacy "0:" wait-list marker is skipped, never popped.
]]
local rcall = redis.call

-- Lists may carry a deprecated "0:<ts>" marker at the tail (BullMQ v4 -> v5 migration).
-- It is not a job, so it is excluded from the count.
local function listCount(key)
  local n = rcall("LLEN", key)
  if n > 0 then
    local last = rcall("LINDEX", key, -1)
    if last and string.sub(last, 1, 2) == "0:" then
      n = n - 1
    end
  end
  return n
end

local out = {}
out[1] = listCount(KEYS[1])              -- wait
out[2] = rcall("LLEN", KEYS[2])          -- active
out[3] = rcall("ZCARD", KEYS[3])         -- completed
out[4] = rcall("ZCARD", KEYS[4])         -- failed
out[5] = rcall("ZCARD", KEYS[5])         -- delayed
out[6] = rcall("ZCARD", KEYS[6])         -- prioritized
out[7] = listCount(KEYS[7])              -- paused
out[8] = rcall("ZCARD", KEYS[8])         -- waiting-children

out[9] = rcall("HEXISTS", KEYS[9], "paused")

-- Pro detection + group count. A group sits in exactly ONE of four status zsets
-- (`groups` = waiting, groups:limit, groups:max, groups:paused — see keys.ts), so
-- "how many groups" is the sum of their ZCARDs and a queue whose groups are all
-- maxed has no `groups` key at all. groups:metas (per-group overrides) and
-- meta.version = "bullmq-pro:x" also mark a Pro queue, so an idle one still shows
-- as Pro. The three extra zsets hang off ARGV[4] (same queue, same hash tag):
-- three more O(1) commands in the same EVALSHA, no extra round trip.
local function card(key)
  local ok, n = pcall(rcall, "ZCARD", key)
  if ok then return n end
  return 0
end
local version = rcall("HGET", KEYS[9], "version")
local groupsCount = card(KEYS[10])
  + card(ARGV[4] .. "groups:limit")
  + card(ARGV[4] .. "groups:max")
  + card(ARGV[4] .. "groups:paused")
local isPro = groupsCount > 0
  or rcall("EXISTS", ARGV[4] .. "groups:metas") == 1
  or (version and string.sub(version, 1, 10) == "bullmq-pro") or false
out[10] = isPro and 1 or 0
out[11] = groupsCount

if ARGV[1] == "1" then
  local points = tonumber(ARGV[2]) or 60
  -- metrics data is LPUSHed by BullMQ, so index 0 is the newest minute.
  out[12] = rcall("LRANGE", KEYS[11], 0, points - 1)
  out[13] = rcall("LRANGE", KEYS[12], 0, points - 1)
else
  out[12] = {}
  out[13] = {}
end

-- Success / failure over a trailing window. completed/failed zset scores are the
-- finishedOn timestamp, so ZCOUNT is O(log N) regardless of queue size.
local since = tonumber(ARGV[3]) or 0
out[14] = rcall("ZCOUNT", KEYS[3], since, "+inf")
out[15] = rcall("ZCOUNT", KEYS[4], since, "+inf")
out[16] = version or false

-- Retention: `removeOnComplete` lives in EACH job's opts, not in meta. We read the
-- opts of ONE job (an HGET on a small hash, O(1)) just to know whether the queue
-- prunes completed jobs. Without it there is no way to tell "99% success" apart
-- from "aggressive pruning making the ratio lie".
-- ARGV[4] = "${prefix}:${queue}:" to build the job hash key.
out[17] = false
local newest = rcall("ZREVRANGE", KEYS[3], 0, 0)
if newest and newest[1] then
  out[17] = rcall("HGET", ARGV[4] .. newest[1], "opts") or false
end

-- BullMQ's cumulative counters. They only exist when the Worker was created with
-- `metrics: { maxDataPoints }`, but when they do they are the ONLY correct source:
-- they are incremented as each job finishes and never decremented, so
-- removeOnComplete cannot touch them. The :data list only gains a point when the
-- minute rolls over, which is why we read the hash and not just the list.
out[18] = rcall("HGET", KEYS[13], "count") or false
out[19] = rcall("HGET", KEYS[14], "count") or false

-- Job schedulers (repeatable jobs). They live outside the 8 states, in the `repeat`
-- zset. ZCARD is O(1), so the count rides along with everything else and the
-- Schedulers tab starts with the right number without a second round trip to Redis.
out[20] = rcall("ZCARD", KEYS[15])

-- `stalled` is an auxiliary SET, NOT a state: BullMQ does not expose it in
-- getState() (a stalled job answers `active`) and it only exists while something is
-- hung. SCARD is O(1), so the count rides along for free in this script.
out[21] = rcall("SCARD", KEYS[16])

return out
