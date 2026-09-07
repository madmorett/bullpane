--[[
  Job schedulers ("repeatable jobs") of ONE queue, read only, one round trip.

  Job schedulers do not live in any of the 8 job states. BullMQ keeps them in:
    `repeat`         zset  schedulerId -> next run (unix ms)
    `repeat:${id}`   hash  name, pattern | every, tz, offset, limit, ic,
                           startDate, endDate, data, opts
  (verified against bullmq 5.81.4 `classes/job-scheduler.js` + a live Redis).

  KEYS[1]   `repeat` zset

  ARGV[1]   start (0-based, inclusive)
  ARGV[2]   end   (0-based, inclusive)
  ARGV[3]   queue key prefix `${prefix}:${queue}:` — used to build `repeat:${id}`
  ARGV[4]   previewBytes: max bytes of `data`/`opts` returned per scheduler

  Returns { total, rows } with
    rows = { { id, next, name, pattern, every, tz, offset, limit, ic,
               startDate, endDate, data, opts, truncated }, ... }

  Redis accesses, each justified:
   1. ZCARD  KEYS[1]                  -> total, for pagination. O(1).
   2. ZRANGE KEYS[1] start end WITHSCORES
                                      -> the page, ordered by next run. O(log N + page).
   3. one HMGET per row on `repeat:${id}`
                                      -> the scheduler definition. O(1) each, and the
                                         page size is bounded by the caller (<= 200),
                                         so this is a bounded fan-out inside a single
                                         script rather than N round trips.
  Every key is `${prefix}:${queue}:...`, i.e. the same hash tag: cluster safe.

  `data`/`opts` are truncated HERE (string.sub) so a scheduler stamping out a
  500 KB template costs the same to list as a tiny one.
]]
local rcall = redis.call
local qprefix = ARGV[3]
local preview = tonumber(ARGV[4]) or 2048

local total = rcall("ZCARD", KEYS[1])
local raw = rcall("ZRANGE", KEYS[1], tonumber(ARGV[1]), tonumber(ARGV[2]), "WITHSCORES")

local rows = {}
for i = 1, #raw, 2 do
  local id = raw[i]
  local next_run = raw[i + 1]

  -- HMGET keeps the field order fixed so the caller does not have to parse pairs.
  -- Field list mirrors SCHEDULER_FIELDS in keys.ts — keep both in sync.
  local h = rcall(
    "HMGET", qprefix .. "repeat:" .. id,
    "name", "pattern", "every", "tz", "offset", "limit", "ic",
    "startDate", "endDate", "data", "opts"
  )

  local truncated = 0
  local data = h[10]
  if data and #data > preview then
    data = string.sub(data, 1, preview)
    truncated = 1
  end
  local opts = h[11]
  if opts and #opts > preview then
    opts = string.sub(opts, 1, preview)
    truncated = 1
  end

  rows[#rows + 1] = {
    id, next_run,
    h[1] or false, h[2] or false, h[3] or false, h[4] or false, h[5] or false,
    h[6] or false, h[7] or false, h[8] or false, h[9] or false,
    data or false, opts or false,
    truncated,
  }
end

return { total, rows }
