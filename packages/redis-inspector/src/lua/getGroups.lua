--[[
  BullMQ Pro groups, read only.

  KEYS[1]   `groups` zset (group id -> score)
  KEYS[2]   `groups:active`
  KEYS[3]   `groups:paused`
  KEYS[4]   `groups:max`
  KEYS[5]   `groups:limit`

  ARGV[1]   start (0-based, inclusive)
  ARGV[2]   end   (0-based, inclusive)
  ARGV[3]   queue key prefix `${prefix}:${queue}:`

  Returns { total, rows } with rows = { { id, score, waiting, status }, ... }

  The exact type of the status keys (set vs zset) is not documented, so
  membership is probed defensively: ZSCORE first, SISMEMBER on a WRONGTYPE
  error. A key of an unexpected third type just yields "not a member".
]]
local rcall = redis.call
local qprefix = ARGV[3]

local function isMember(key, id)
  local ok, res = pcall(rcall, "ZSCORE", key, id)
  if ok then return res ~= false and res ~= nil end
  local ok2, res2 = pcall(rcall, "SISMEMBER", key, id)
  if ok2 then return res2 == 1 end
  return false
end

local total = rcall("ZCARD", KEYS[1])
local raw = rcall("ZRANGE", KEYS[1], tonumber(ARGV[1]), tonumber(ARGV[2]), "WITHSCORES")

local rows = {}
for i = 1, #raw, 2 do
  local gid = raw[i]
  local score = raw[i + 1]
  local waiting = rcall("LLEN", qprefix .. "groups:" .. gid)
  local status
  if isMember(KEYS[3], gid) then status = "paused"
  elseif isMember(KEYS[5], gid) then status = "rate-limited"
  elseif isMember(KEYS[4], gid) then status = "maxed"
  elseif isMember(KEYS[2], gid) then status = "active"
  elseif waiting > 0 then status = "waiting"
  else status = "unknown"
  end
  rows[#rows + 1] = { gid, score, waiting, status }
end

return { total, rows }
