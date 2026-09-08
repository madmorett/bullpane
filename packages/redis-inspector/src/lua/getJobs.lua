--[[
  One page of job summaries for a state (or a Pro group list) in one round trip.

  KEYS[1]     the state key (list or zset)
  KEYS[2]     optional, list kind only: a zset whose members come AFTER the list —
              a Pro group's prioritized jobs (`groups:${gid}:p`), which Pro serves
              once the group's list is empty (getGroup.lua in bullmq-pro).

  ARGV[1]     "list" | "zset"
  ARGV[2]     start (0-based, inclusive)
  ARGV[3]     end   (0-based, inclusive)
  ARGV[4]     "asc" | "desc"
  ARGV[5]     queue key prefix `${prefix}:${queue}:` (job hashes live at prefix .. id)
  ARGV[6]     previewBytes: `data` / `returnvalue` are cut to this many bytes IN REDIS
  ARGV[7]     maxFieldBytes: a `data` / `returnvalue` field LONGER than this is not
              read at all (HSTRLEN first, O(1)). HMGET copies the whole field into
              Lua before we can truncate it, so a page of 200 × 1 MB payloads would
              block Redis for ~300 ms; with the cap a page costs at most
              pageSize × maxFieldBytes. The row still carries the size so the UI
              can say "payload 1.0 MB — open the job".
  ARGV[8..]   hash fields to HMGET, in the order the caller expects them back

  Returns { total, jobs } where each job is
    { id, field1, field2, ..., dataTruncated (0|1), dataBytes }
  Hashes that vanished between the range read and the HMGET are skipped.

  Ordering mirrors bullmq's getRanges (queue-getters.js):
    lists are LPUSHed, so head = newest. desc = LRANGE start end; asc reads from the tail.
    zsets: desc = ZREVRANGE (highest score = newest), asc = ZRANGE.
]]
local rcall = redis.call
local key = KEYS[1]
local extra = KEYS[2]
local kind = ARGV[1]
local rangeStart = tonumber(ARGV[2])
local rangeEnd = tonumber(ARGV[3])
local desc = ARGV[4] ~= "asc"
local qprefix = ARGV[5]
local previewBytes = tonumber(ARGV[6])
local maxFieldBytes = tonumber(ARGV[7])

local fields = {}
for i = 8, #ARGV do
  fields[#fields + 1] = ARGV[i]
end
-- A field name no job hash has: swapped in for `data` / `returnvalue` when the
-- real field is over the cap, so the HMGET keeps its shape and returns nil there.
local SKIP = "\0skip"

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
  -- The page runs past the list: continue into the appended zset (ascending score
  -- = highest priority first, the order Pro will serve them in).
  if extra then
    local listTotal = total
    local extraTotal = rcall("ZCARD", extra)
    total = listTotal + extraTotal
    if extraTotal > 0 and (rangeEnd == -1 or rangeEnd >= listTotal) then
      local from = math.max(0, rangeStart - listTotal)
      local to = -1
      if rangeEnd ~= -1 then to = rangeEnd - listTotal end
      local more = rcall("ZRANGE", extra, from, to)
      for _, id in ipairs(more) do ids[#ids + 1] = id end
    end
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
    local hkey = qprefix .. id
    -- Size first (O(1)); only then decide whether the payload is worth copying.
    local dataBytes = dataIdx and rcall("HSTRLEN", hkey, "data") or 0
    local retBytes = retIdx and rcall("HSTRLEN", hkey, "returnvalue") or 0
    local want = fields
    if (dataIdx and dataBytes > maxFieldBytes) or (retIdx and retBytes > maxFieldBytes) then
      want = {}
      for i = 1, #fields do want[i] = fields[i] end
      if dataIdx and dataBytes > maxFieldBytes then want[dataIdx] = SKIP end
      if retIdx and retBytes > maxFieldBytes then want[retIdx] = SKIP end
    end
    local vals = rcall("HMGET", hkey, unpack(want))
    local alive = false
    for i = 1, #vals do
      if vals[i] then alive = true break end
    end
    if alive then
      local truncated = 0
      -- Truncate INSIDE Redis: a 500 KB payload costs the same to render as a tiny one.
      if dataIdx and dataBytes > previewBytes then
        if vals[dataIdx] then vals[dataIdx] = string.sub(vals[dataIdx], 1, previewBytes) end
        truncated = 1
      end
      if retIdx and vals[retIdx] and #vals[retIdx] > previewBytes then
        vals[retIdx] = string.sub(vals[retIdx], 1, previewBytes)
      end
      local row = { id }
      for i = 1, #vals do row[#row + 1] = vals[i] end
      row[#row + 1] = truncated
      row[#row + 1] = dataBytes
      jobs[#jobs + 1] = row
    end
  end
end

return { total, jobs }
