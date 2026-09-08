--[[
  BullMQ Pro groups, read only. Layout: keys.ts (verified against bullmq-pro 7.48.0).

  KEYS[1]  groups               zset, status "waiting"  (score = round-robin order)
  KEYS[2]  groups:limit         zset, status "limited"  (score = unix ms the limit lifts)
  KEYS[3]  groups:max           zset, status "maxed"    (score = unix ms it hit the cap)
  KEYS[4]  groups:paused        zset, status "paused"   (score = unix ms it was paused)
  KEYS[5]  groups:active:count  hash  gid -> jobs being processed
  KEYS[6]  groups:concurrency   hash  gid -> legacy per-group concurrency

  ARGV[1]  start (0-based, inclusive)
  ARGV[2]  end   (0-based, inclusive; -1 = to the end)
  ARGV[3]  queue key prefix `${prefix}:${queue}:`

  A group sits in exactly one of the four status zsets, so "all groups" is their
  concatenation in that order — the same order QueuePro.getGroups pages through.
  The per-group keys (`groups:${gid}`, `:p`, `:meta`) mirror GROUP_KEY in keys.ts
  and hang off ARGV[3]: same queue, same hash tag, cluster safe. Everything here
  is O(1) per group on the page (LLEN / ZCARD / HGET / HMGET).

  Returns { total, { waiting, limited, maxed, paused }, rows } with
    rows = { { id, status, waiting, prioritized, active, conc|false, lm|false, ld|false, score }, ... }
  where waiting already includes prioritized.
]]
local rcall = redis.call
local qprefix = ARGV[3]
local rangeStart = tonumber(ARGV[1])
local rangeEnd = tonumber(ARGV[2])

local statuses = { "waiting", "limited", "maxed", "paused" }
local counts = {}
local total = 0
for i = 1, 4 do
  counts[i] = rcall("ZCARD", KEYS[i])
  total = total + counts[i]
end
if rangeEnd < 0 or rangeEnd >= total then rangeEnd = total - 1 end

-- Page across the four zsets as if they were one list: zset i owns the virtual
-- indices [offset, offset + counts[i] - 1].
local rows = {}
local offset = 0
for i = 1, 4 do
  local n = counts[i]
  local last = offset + n - 1
  if n > 0 and rangeStart <= last and rangeEnd >= offset then
    local from = math.max(rangeStart, offset) - offset
    local to = math.min(rangeEnd, last) - offset
    local raw = rcall("ZRANGE", KEYS[i], from, to, "WITHSCORES")
    for j = 1, #raw, 2 do
      local gid = raw[j]
      local groupKey = qprefix .. "groups:" .. gid
      local waiting = rcall("LLEN", groupKey)
      local prioritized = rcall("ZCARD", groupKey .. ":p")
      local active = tonumber(rcall("HGET", KEYS[5], gid)) or 0
      local meta = rcall("HMGET", groupKey .. ":meta", "conc", "lm", "ld")
      -- Pro reads the legacy hash first, then the meta hash (increaseGroupConcurrency.lua).
      local conc = rcall("HGET", KEYS[6], gid) or meta[1] or false
      rows[#rows + 1] = { gid, statuses[i], waiting + prioritized, prioritized, active, conc, meta[2] or false, meta[3] or false, raw[j + 1] }
    end
  end
  offset = offset + n
end

return { total, counts, rows }
