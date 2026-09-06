--[[
  One page of job summaries for a state (or a Pro group list) in one round trip.

  KEYS[1]     the state key (list or zset)

  ARGV[1]     "list" | "zset"
  ARGV[2]     start (0-based, inclusive)
  ARGV[3]     end   (0-based, inclusive)
  ARGV[4]     "asc" | "desc"
  ARGV[5]     queue key prefix `${prefix}:${queue}:` (job hashes live at prefix .. id)
  ARGV[6]     previewBytes: `data` / `returnvalue` are cut to this many bytes IN REDIS
  ARGV[7..]   hash fields to HMGET, in the order the caller expects them back

  Returns { total, jobs } where each job is
    { id, field1, field2, ..., dataTruncated (0|1) }
  Hashes that vanished between the range read and the HMGET are skipped.

  Ordering mirrors bullmq's getRanges (queue-getters.js):
    lists are LPUSHed, so head = newest. desc = LRANGE start end; asc reads from the tail.
    zsets: desc = ZREVRANGE (highest score = newest), asc = ZRANGE.
]]
local rcall = redis.call
local key = KEYS[1]
local kind = ARGV[1]
local rangeStart = tonumber(ARGV[2])
local rangeEnd = tonumber(ARGV[3])
local desc = ARGV[4] ~= "asc"
local qprefix = ARGV[5]
local previewBytes = tonumber(ARGV[6])

local fields = {}
for i = 7, #ARGV do
  fields[#fields + 1] = ARGV[i]
end

-- Positions of the two payload fields we truncate.
local dataIdx, retIdx = nil, nil
for i, f in ipairs(fields) do
  if f == "data" then dataIdx = i end
  if f == "returnvalue" then retIdx = i end
end

local function isMarker(id)
  return string.sub(id, 1, 2) == "0:"
end

local total
local ids
if kind == "list" then
  total = rcall("LLEN", key)
  -- legacy marker at the tail is not a job
  if total > 0 then
    local last = rcall("LINDEX", key, -1)
    if last and isMarker(last) then total = total - 1 end
  end
  if desc then
    ids = rcall("LRANGE", key, rangeStart, rangeEnd)
  else
    -- asc = oldest first = from the tail. Reverse afterwards.
    -- Explicit branches: -( -1 + 1 ) is -0 in Lua, which Redis rejects as a non-integer.
    local fromTail = 0
    if rangeEnd ~= -1 then fromTail = -(rangeEnd + 1) end
    local toTail = -1
    if rangeStart ~= -1 then toTail = -(rangeStart + 1) end
    local raw = rcall("LRANGE", key, fromTail, toTail)
    ids = {}
    for i = #raw, 1, -1 do ids[#ids + 1] = raw[i] end
  end
else
  total = rcall("ZCARD", key)
  if desc then
    ids = rcall("ZREVRANGE", key, rangeStart, rangeEnd)
  else
    ids = rcall("ZRANGE", key, rangeStart, rangeEnd)
  end
end

local jobs = {}
for _, id in ipairs(ids) do
  if not isMarker(id) then
    local vals = rcall("HMGET", qprefix .. id, unpack(fields))
    local alive = false
    for i = 1, #vals do
      if vals[i] then alive = true break end
    end
    if alive then
      local truncated = 0
      -- Truncate INSIDE Redis: a 500 KB payload costs the same to render as a tiny one.
      if dataIdx and vals[dataIdx] and #vals[dataIdx] > previewBytes then
        vals[dataIdx] = string.sub(vals[dataIdx], 1, previewBytes)
        truncated = 1
      end
      if retIdx and vals[retIdx] and #vals[retIdx] > previewBytes then
        vals[retIdx] = string.sub(vals[retIdx], 1, previewBytes)
      end
      local row = { id }
      for i = 1, #vals do row[#row + 1] = vals[i] end
      row[#row + 1] = truncated
      jobs[#jobs + 1] = row
    end
  end
end

return { total, jobs }
