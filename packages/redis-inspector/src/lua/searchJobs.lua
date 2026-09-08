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
  ARGV[8]     maxFieldBytes: a `data` field longer than this is NOT read or searched
              (HSTRLEN first). The job still matches on id / name / failedReason
              and is counted in `skipped` so the UI can say so.
  ARGV[9]     byteBudget: stop the call once this many payload bytes were copied
              into Lua, even if `batch` hashes were not reached. The cursor comes
              back as usual and the UI keeps streaming.
  ARGV[10..]  hash fields to HMGET (must include name, data, failedReason)

  Returns { matches, nextCursor, scanned, total, skipped }
    matches     rows shaped exactly like getJobs.lua rows (…, dataTruncated, dataBytes)
    nextCursor  index to pass back next time, or -1 when the state is exhausted
    scanned     hashes inspected in this call
    skipped     hashes whose data was over maxFieldBytes and not searched

  The match is a plain (non-pattern) case-insensitive string.find over id, name,
  data and failedReason, each field on its own (no concatenated haystack: every
  `..` on a 1 MB string is another 1 MB copy). Two bounds make the cost of ONE
  call independent of both queue size and payload size: at most `batch` hashes
  and at most `byteBudget` payload bytes. Before them a search over 1000 × 1 MB
  jobs kept Redis busy for 13 s; with them a call is a few milliseconds.
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
local maxFieldBytes = tonumber(ARGV[8])
local byteBudget = tonumber(ARGV[9])

local fields = {}
for i = 10, #ARGV do fields[#fields + 1] = ARGV[i] end
local SKIP = "\0skip"

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
local skipped = 0
local bytes = 0
local stoppedEarly = false

local function has(hay, needle)
  return hay and string.find(string.lower(hay), needle, 1, true) ~= nil
end

for _, id in ipairs(ids) do
  scanned = scanned + 1
  if string.sub(id, 1, 2) ~= "0:" then
    local hkey = qprefix .. id
    local dataBytes = dataIdx and rcall("HSTRLEN", hkey, "data") or 0
    local retBytes = retIdx and rcall("HSTRLEN", hkey, "returnvalue") or 0
    local skipData = dataIdx and dataBytes > maxFieldBytes
    local want = fields
    if skipData or (retIdx and retBytes > maxFieldBytes) then
      want = {}
      for i = 1, #fields do want[i] = fields[i] end
      if skipData then want[dataIdx] = SKIP end
      if retIdx and retBytes > maxFieldBytes then want[retIdx] = SKIP end
    end
    local vals = rcall("HMGET", hkey, unpack(want))
    local alive = false
    for i = 1, #vals do
      if vals[i] then alive = true break end
    end
    if alive then
      if skipData then skipped = skipped + 1 else bytes = bytes + dataBytes end
      local hit = has(id, needle)
        or (nameIdx and has(vals[nameIdx], needle))
        or (dataIdx and not skipData and has(vals[dataIdx], needle))
        or (reasonIdx and has(vals[reasonIdx], needle))
      if hit then
        local truncated = 0
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
        matches[#matches + 1] = row
        found = found + 1
        if found >= limit then
          stoppedEarly = true
          break
        end
      end
      if bytes >= byteBudget then
        stoppedEarly = true
        break
      end
    end
  end
end

local nextCursor = cursor + scanned
-- Exhausted when we walked past the end of the state and did not stop early.
if not stoppedEarly and (#ids < batch or nextCursor >= total) then
  nextCursor = -1
end

return { matches, nextCursor, scanned, total, skipped }
