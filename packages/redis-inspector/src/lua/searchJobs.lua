--[[
  Bounded, resumable substring search over the jobs of one state.

  KEYS[1]     the state key (list or zset)

  ARGV[1]     "list" | "zset"
  ARGV[2]     cursor: index (newest = 0) of the first job to inspect
  ARGV[3]     batch: max number of job hashes inspected in THIS call (maxScanPerCall)
  ARGV[4]     needle, already lower-cased by the caller
  ARGV[5]     limit: stop early once this many matches are found
  ARGV[6]     queue key prefix `${prefix}:${queue}:`
  ARGV[7]     previewBytes (same truncation as getJobs)
  ARGV[8..]   hash fields to HMGET (must include name, data, failedReason)

  Returns { matches, nextCursor, scanned, total }
    matches     rows shaped exactly like getJobs.lua rows
    nextCursor  index to pass back next time, or -1 when the state is exhausted
    scanned     hashes inspected in this call

  The match is a plain (non-pattern) case-insensitive string.find over
  id, name, data and failedReason. Never scans more than `batch` hashes, so the
  cost per call is bounded no matter how big the state is; the UI keeps calling
  with the cursor to stream results in.
]]
local rcall = redis.call
local key = KEYS[1]
local kind = ARGV[1]
local cursor = tonumber(ARGV[2])
local batch = tonumber(ARGV[3])
local needle = ARGV[4]
local limit = tonumber(ARGV[5])
local qprefix = ARGV[6]
local previewBytes = tonumber(ARGV[7])

local fields = {}
for i = 8, #ARGV do fields[#fields + 1] = ARGV[i] end

local dataIdx, retIdx, nameIdx, reasonIdx = nil, nil, nil, nil
for i, f in ipairs(fields) do
  if f == "data" then dataIdx = i end
  if f == "returnvalue" then retIdx = i end
  if f == "name" then nameIdx = i end
  if f == "failedReason" then reasonIdx = i end
end

local total
local ids
if kind == "list" then
  total = rcall("LLEN", key)
  ids = rcall("LRANGE", key, cursor, cursor + batch - 1)   -- head = newest
else
  total = rcall("ZCARD", key)
  ids = rcall("ZREVRANGE", key, cursor, cursor + batch - 1) -- highest score = newest
end

local matches = {}
local scanned = 0
local found = 0
local stoppedEarly = false

for _, id in ipairs(ids) do
  scanned = scanned + 1
  if string.sub(id, 1, 2) ~= "0:" then
    local vals = rcall("HMGET", qprefix .. id, unpack(fields))
    local alive = false
    for i = 1, #vals do
      if vals[i] then alive = true break end
    end
    if alive then
      local hay = string.lower(id)
      if nameIdx and vals[nameIdx] then hay = hay .. "\0" .. string.lower(vals[nameIdx]) end
      if dataIdx and vals[dataIdx] then hay = hay .. "\0" .. string.lower(vals[dataIdx]) end
      if reasonIdx and vals[reasonIdx] then hay = hay .. "\0" .. string.lower(vals[reasonIdx]) end
      -- plain find: the 4th argument disables Lua patterns, so user input is never a pattern
      if string.find(hay, needle, 1, true) then
        local truncated = 0
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
        matches[#matches + 1] = row
        found = found + 1
        if found >= limit then
          stoppedEarly = true
          break
        end
      end
    end
  end
end

local nextCursor = cursor + scanned
-- Exhausted when we walked past the end of the state and did not stop early.
if not stoppedEarly and (#ids < batch or nextCursor >= total) then
  nextCursor = -1
end

return { matches, nextCursor, scanned, total }
