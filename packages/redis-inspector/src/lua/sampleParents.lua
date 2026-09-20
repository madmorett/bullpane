--[[
  Flow detection: sample the newest N jobs of several states and aggregate the
  queue key of their parent (BullMQ flow children carry `parentKey` and a
  `parent` JSON {id, queueKey} in their hash).

  KEYS[1..n]   state keys to sample
  ARGV[1]      per-state sample size N
  ARGV[2]      queue key prefix `${prefix}:${queue}:`
  ARGV[3..]    "list" | "zset" for each KEYS[i]  (ARGV[2 + i])

  Returns { sampled, pairs } where pairs = { parentQueueKey1, count1, parentQueueKey2, count2, ... }

  Cost: at most n * N HMGETs, all inside Redis, one round trip. The caller caches.
]]
local rcall = redis.call
local n = tonumber(ARGV[1])
local qprefix = ARGV[2]

local counts = {}
local order = {}
local sampled = 0

for i = 1, #KEYS do
  local kind = ARGV[2 + i]
  local ids
  if kind == "list" then
    ids = rcall("LRANGE", KEYS[i], 0, n - 1)
  else
    ids = rcall("ZREVRANGE", KEYS[i], 0, n - 1)
  end
  for _, id in ipairs(ids) do
    if string.sub(id, 1, 2) ~= "0:" then
      local vals = rcall("HMGET", qprefix .. id, "parentKey", "parent")
      sampled = sampled + 1
      local qk = nil
      if vals[2] then
        -- preferred: parent JSON carries the queue key verbatim
        local ok, parsed = pcall(cjson.decode, vals[2])
        if ok and type(parsed) == "table" and type(parsed.queueKey) == "string" then
          qk = parsed.queueKey
        end
      end
      if not qk and vals[1] then
        -- fallback: parentKey is `${prefix}:${queue}:${id}`; drop the trailing `:id`
        local cut = string.match(vals[1], "^(.*):[^:]+$")
        if cut then qk = cut end
      end
      if qk then
        if not counts[qk] then
          counts[qk] = 0
          order[#order + 1] = qk
        end
        counts[qk] = counts[qk] + 1
      end
    end
  end
end

local out = {}
for _, qk in ipairs(order) do
  out[#out + 1] = qk
  out[#out + 1] = counts[qk]
end

return { sampled, out }
