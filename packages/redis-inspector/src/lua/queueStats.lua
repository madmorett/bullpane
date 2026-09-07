--[[
  Counts + flags for ONE queue in a single round trip.

  KEYS[1..8]  state keys in STATE_ORDER:
              wait, active, completed, failed, delayed, prioritized, paused, waiting-children
  KEYS[9]     meta hash
  KEYS[10]    Pro `groups` zset
  KEYS[11]    metrics:completed:data list
  KEYS[12]    metrics:failed:data list
  KEYS[13]    metrics:completed hash  (campo `count`, acumulado desde sempre)
  KEYS[14]    metrics:failed hash
  KEYS[15]    `repeat` zset (job schedulers)
  KEYS[16]    `stalled` SET (ids marcados como stallados pelo StalledCheck)

  ARGV[1]     withMetrics "1" | "0"
  ARGV[2]     number of metric points (newest N minutes)
  ARGV[3]     window start (unix ms) for the success/failure rate ZCOUNTs
  ARGV[4]     `${prefix}:${queue}:` (para ler o opts de um job e detectar retenção)

  Returns a flat array:
    [1..8]  counts (LLEN for lists, ZCARD for zsets)
    [9]     1 when the queue is paused (meta.paused exists)
    [10]    1 when the `groups` zset exists (BullMQ Pro)
    [11]    ZCARD groups
    [12]    completed metric points, newest first (empty when withMetrics = 0)
    [13]    failed metric points, newest first
    [14]    ZCOUNT completed since ARGV[3]  (scores are finishedOn timestamps; O(log N))
    [15]    ZCOUNT failed since ARGV[3]
    [16]    meta.version ("bullmq:5.x" / "bullmq-pro:7.x") or false
    [17]    `opts` do job mais recente em completed, ou false. Serve só para
            descobrir se a fila usa removeOnComplete: com retenção agressiva as
            contagens dos zsets mentem, e o caller precisa avisar o usuário.
    [20]    ZCARD `repeat` — quantos job schedulers a fila tem. Um ZCARD é O(1),
            então cabe aqui e o badge da aba Schedulers não custa uma ida extra.
    [21]    SCARD `stalled` — jobs que perderam o lock. Custo: UM comando O(1) a
            mais no mesmo EVALSHA (nenhuma ida extra ao Redis). Vale o orçamento
            porque é o único jeito de a aba `active` dizer "3 destes travaram";
            sem isso o operador vê "active 8" e não sabe que metade está morta.

  Cluster safe: every key belongs to the same queue (same hash tag).
  Read only: the legacy "0:" wait-list marker is skipped, never popped.
]]
local rcall = redis.call

-- Lists may carry a deprecated "0:<ts>" marker at the tail (BullMQ v4 -> v5 migration).
-- It is not a job, so it is excluded from the count.
local function listCount(key)
  local n = rcall("LLEN", key)
  if n > 0 then
    local last = rcall("LINDEX", key, -1)
    if last and string.sub(last, 1, 2) == "0:" then
      n = n - 1
    end
  end
  return n
end

local out = {}
out[1] = listCount(KEYS[1])              -- wait
out[2] = rcall("LLEN", KEYS[2])          -- active
out[3] = rcall("ZCARD", KEYS[3])         -- completed
out[4] = rcall("ZCARD", KEYS[4])         -- failed
out[5] = rcall("ZCARD", KEYS[5])         -- delayed
out[6] = rcall("ZCARD", KEYS[6])         -- prioritized
out[7] = listCount(KEYS[7])              -- paused
out[8] = rcall("ZCARD", KEYS[8])         -- waiting-children

out[9] = rcall("HEXISTS", KEYS[9], "paused")

-- Pro detection. `groups` is a zset of group ids; EXISTS is O(1). A queue created
-- by bullmq-pro also stamps meta.version = "bullmq-pro:x.y.z", even before any
-- grouped job exists, so we accept either signal.
local version = rcall("HGET", KEYS[9], "version")
if rcall("EXISTS", KEYS[10]) == 1 then
  out[10] = 1
  out[11] = rcall("ZCARD", KEYS[10])
else
  out[10] = (version and string.sub(version, 1, 10) == "bullmq-pro") and 1 or 0
  out[11] = 0
end

if ARGV[1] == "1" then
  local points = tonumber(ARGV[2]) or 60
  -- metrics data is LPUSHed by BullMQ, so index 0 is the newest minute.
  out[12] = rcall("LRANGE", KEYS[11], 0, points - 1)
  out[13] = rcall("LRANGE", KEYS[12], 0, points - 1)
else
  out[12] = {}
  out[13] = {}
end

-- Success / failure over a trailing window. completed/failed zset scores are the
-- finishedOn timestamp, so ZCOUNT is O(log N) regardless of queue size.
local since = tonumber(ARGV[3]) or 0
out[14] = rcall("ZCOUNT", KEYS[3], since, "+inf")
out[15] = rcall("ZCOUNT", KEYS[4], since, "+inf")
out[16] = version or false

-- Retenção: `removeOnComplete` vive no opts de CADA job, não no meta. Lemos o
-- opts de UM job (HGET num hash pequeno, O(1)) só para saber se a fila poda os
-- concluídos. Sem isso não há como diferenciar "99% de sucesso" de
-- "poda agressiva fazendo a razão mentir".
-- ARGV[4] = "${prefix}:${queue}:" para montar a chave do hash do job.
out[17] = false
local newest = rcall("ZREVRANGE", KEYS[3], 0, 0)
if newest and newest[1] then
  out[17] = rcall("HGET", ARGV[4] .. newest[1], "opts") or false
end

-- Contadores acumulados do BullMQ. Só existem quando o Worker foi criado com
-- `metrics: { maxDataPoints }`, mas quando existem são a ÚNICA fonte correta:
-- são incrementados quando o job termina e nunca diminuem, então removeOnComplete
-- não os afeta. A lista :data só ganha ponto na virada do minuto, por isso lemos
-- o hash e não só a lista.
out[18] = rcall("HGET", KEYS[13], "count") or false
out[19] = rcall("HGET", KEYS[14], "count") or false

-- Job schedulers (repeatable jobs). Vivem fora dos 8 estados, na zset `repeat`.
-- ZCARD é O(1), então a contagem viaja junto com o resto e a aba Schedulers já
-- nasce com o número certo sem uma segunda ida ao Redis.
out[20] = rcall("ZCARD", KEYS[15])

-- `stalled` é um SET auxiliar, NÃO um estado: o BullMQ não o expõe em
-- getState() (um job stallado responde `active`) e ele só existe enquanto algo
-- está travado. SCARD é O(1), então a contagem viaja de graça neste script.
out[21] = rcall("SCARD", KEYS[16])

return out
