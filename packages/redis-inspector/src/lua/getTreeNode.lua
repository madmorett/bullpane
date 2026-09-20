--[[
  One node of a flow tree: the job's own fields, its state, and the KEYS of its
  children — in one round trip, without shipping logs or return values.

  Why a script separate from getJob.lua: the tree walk reads many jobs and only
  needs a handful of fields plus the child keys. getJob HGETALLs the whole hash
  and LRANGEs the logs, which on a 300-node tree is a lot of bytes for data the
  graph never renders.

  KEYS[1]      job hash
  KEYS[2]      `${id}:dependencies` set  (unprocessed children, members are full job keys)
  KEYS[3]      `${id}:processed` hash    (processed children, fields are full job keys)
  KEYS[4..11]  state keys in STATE_ORDER:
               wait, active, completed, failed, delayed, prioritized, paused, waiting-children

  ARGV[1]      job id
  ARGV[2]      max child keys to return (the rest are counted, not listed)

  Returns nil when the hash does not exist, otherwise
    { fieldsFlat, state, unprocessedCount, processedCount, childKeys, childrenTruncated }

  `childKeys` mixes unprocessed and processed children; the caller does not need
  to tell them apart from this list because each child reports its own state.
  Only this job's own keys are touched, so the call is safe to pipeline per queue
  on a cluster. Children living in another queue are walked by the caller in a
  separate, per-queue pipeline.
]]
local rcall = redis.call
local jobKey = KEYS[1]

if rcall("EXISTS", jobKey) == 0 then
  return nil
end

-- Only the fields the tree renders. HMGET keeps a fat `data` payload in Redis.
local fields = rcall("HMGET", jobKey,
  "name", "timestamp", "finishedOn", "processedOn",
  "attemptsMade", "failedReason", "progress", "parentKey", "parent", "opts")

local id = ARGV[1]
local limit = tonumber(ARGV[2]) or 100

local state = "unknown"
if rcall("ZSCORE", KEYS[6], id) then state = "completed"
elseif rcall("ZSCORE", KEYS[7], id) then state = "failed"
elseif rcall("ZSCORE", KEYS[8], id) then state = "delayed"
elseif rcall("ZSCORE", KEYS[9], id) then state = "prioritized"
elseif rcall("ZSCORE", KEYS[11], id) then state = "waiting-children"
else
  local function inList(key)
    local ok, pos = pcall(rcall, "LPOS", key, id)
    if ok and pos then return true end
    return false
  end
  if inList(KEYS[5]) then state = "active"
  elseif inList(KEYS[4]) then state = "waiting"
  elseif inList(KEYS[10]) then state = "paused"
  end
end

local unprocessed = rcall("SCARD", KEYS[2])
local processed = rcall("HLEN", KEYS[3])

-- SSCAN/HSCAN with COUNT rather than SMEMBERS/HKEYS: a fan-out parent can have
-- tens of thousands of children and we only ever draw `limit` of them.
local children = {}
local truncated = 0

if limit > 0 and unprocessed > 0 then
  local cursor = "0"
  repeat
    local res = rcall("SSCAN", KEYS[2], cursor, "COUNT", 200)
    cursor = res[1]
    for _, member in ipairs(res[2]) do
      if #children >= limit then
        truncated = 1
        break
      end
      children[#children + 1] = member
    end
  until cursor == "0" or truncated == 1
end

if limit > 0 and processed > 0 and truncated == 0 then
  local cursor = "0"
  repeat
    local res = rcall("HSCAN", KEYS[3], cursor, "COUNT", 200)
    cursor = res[1]
    -- HSCAN returns field, value, field, value...; the value is the child's
    -- return value, which we deliberately do not ship.
    for i = 1, #res[2], 2 do
      if #children >= limit then
        truncated = 1
        break
      end
      children[#children + 1] = res[2][i]
    end
  until cursor == "0" or truncated == 1
end

if (unprocessed + processed) > #children then
  truncated = 1
end

return { fields, state, unprocessed, processed, children, truncated }
