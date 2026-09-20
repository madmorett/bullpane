--[[
  Full detail of one job in one round trip.

  KEYS[1]      job hash
  KEYS[2]      `${id}:logs` list
  KEYS[3]      `${id}:dependencies` set (unprocessed children)
  KEYS[4]      `${id}:processed` hash (processed children)
  KEYS[5..12]  state keys in STATE_ORDER:
               wait, active, completed, failed, delayed, prioritized, paused, waiting-children

  ARGV[1]      job id
  ARGV[2]      how many log lines (from the tail) to return

  Returns nil when the hash does not exist, otherwise
    { hgetallFlat, logs, logsCount, dependenciesCount, processedCount, state, delayedScore }
  `delayedScore` is the job's score in the `delayed` zset (false otherwise):
  timestamp * 0x1000 + jobId % 0x1000, i.e. when the job becomes runnable.

  State detection: ZSCORE for zsets (O(1)), LPOS for lists (Redis >= 6.0.6,
  O(N) but in C and without shipping the list). LPOS is wrapped in pcall so an
  older Redis degrades to "unknown" instead of erroring.
]]
local rcall = redis.call
local jobKey = KEYS[1]

if rcall("EXISTS", jobKey) == 0 then
  return nil
end

local hash = rcall("HGETALL", jobKey)

local tail = tonumber(ARGV[2]) or 100
local logs = rcall("LRANGE", KEYS[2], -tail, -1)
local logsCount = rcall("LLEN", KEYS[2])
local depsCount = rcall("SCARD", KEYS[3])
local processedCount = rcall("HLEN", KEYS[4])

local id = ARGV[1]
local state = "unknown"
local delayedScore = false

-- zsets first: cheap and the most common resting states
local inDelayed = rcall("ZSCORE", KEYS[9], id)
if rcall("ZSCORE", KEYS[7], id) then state = "completed"
elseif rcall("ZSCORE", KEYS[8], id) then state = "failed"
elseif inDelayed then state = "delayed" delayedScore = inDelayed
elseif rcall("ZSCORE", KEYS[10], id) then state = "prioritized"
elseif rcall("ZSCORE", KEYS[12], id) then state = "waiting-children"
else
  local function inList(key)
    local ok, pos = pcall(rcall, "LPOS", key, id)
    if ok and pos then return true end
    return false
  end
  if inList(KEYS[6]) then state = "active"
  elseif inList(KEYS[5]) then state = "waiting"
  elseif inList(KEYS[11]) then state = "paused"
  end
end

return { hash, logs, logsCount, depsCount, processedCount, state, delayedScore }
