/**
 * Every Redis key name the inspector touches, in ONE place.
 *
 * BullMQ lays a queue out as `${prefix}:${queue}:${suffix}` (see
 * bullmq/dist/esm/classes/queue-keys.js). The prefix defaults to "bull". In
 * cluster mode users name the queue with a hash tag (e.g. `{orders}`) so all
 * keys of one queue land on the same slot; we treat the queue name literally,
 * so that works without any special casing here.
 *
 * BullMQ Pro adds group keys under the same qualified name (`groups*`). Their
 * exact layout is not published, so they live here so a change is a one-file fix.
 */
import { STATE_KEY, type JobState } from "@bullpane/shared";

/** `${prefix}:${queue}` — what BullMQ calls the "queue qualified name". */
export function queueKey(prefix: string, queue: string): string {
  return `${prefix}:${queue}`;
}

/** `${prefix}:${queue}:` — the base every other key of the queue hangs off. */
export function queueKeyPrefix(prefix: string, queue: string): string {
  return `${queueKey(prefix, queue)}:`;
}

/** Standard BullMQ suffixes (relative to `${prefix}:${queue}:`). */
export const QUEUE_KEY = {
  wait: "wait",
  active: "active",
  completed: "completed",
  failed: "failed",
  delayed: "delayed",
  prioritized: "prioritized",
  paused: "paused",
  waitingChildren: "waiting-children",
  /** hash: `paused` field present => queue paused; also holds `opts.maxLenEvents` etc. */
  meta: "meta",
  /** string: last job id counter */
  id: "id",
  /** stream of queue events */
  events: "events",
  /** set of stalled job ids */
  stalled: "stalled",
  /** rate limiter key */
  limiter: "limiter",
  /** hash: count / prevTS / prevCount for completed metrics */
  metricsCompleted: "metrics:completed",
  /** list of per-minute completed counts, LPUSHed => index 0 is the newest minute */
  metricsCompletedData: "metrics:completed:data",
  metricsFailed: "metrics:failed",
  metricsFailedData: "metrics:failed:data",
  /**
   * zset: job scheduler id -> next run (unix ms). Same key BullMQ calls `repeat`
   * (see bullmq/dist/esm/classes/queue-keys.js). Legacy repeatable jobs share it.
   */
  repeat: "repeat",
} as const;

/**
 * Job scheduler ("repeatable job") keys, relative to `${prefix}:${queue}:`.
 *
 * Layout verified against bullmq 5.81.4 on a live Redis:
 *   `repeat`            zset  schedulerId -> next run unix ms
 *   `repeat:${id}`      hash  name, pattern | every, tz, offset, limit, ic
 *                             (iteration count), startDate, endDate, data, opts
 *   `repeat:${id}:${millis}`  hash  the produced delayed job (a normal job hash,
 *                             also reachable as `delayed` member `repeat:${id}:${millis}`)
 * Everything hangs off the queue's own prefix, so it is cluster safe.
 */
export const SCHEDULER_KEY = {
  repeat: QUEUE_KEY.repeat,
  scheduler: (id: string) => `${QUEUE_KEY.repeat}:${id}`,
} as const;

/**
 * Fields of a `repeat:${id}` hash we read, in the order getSchedulers.lua HMGETs
 * them. `ic` is bullmq's iteration counter and doubles as the marker that tells a
 * real job scheduler apart from a legacy repeatable key (see JobScheduler.isJobScheduler).
 */
export const SCHEDULER_FIELDS = [
  "name",
  "pattern",
  "every",
  "tz",
  "offset",
  "limit",
  "ic",
  "startDate",
  "endDate",
  "data",
  "opts",
] as const;

/** Per-job suffixes (relative to `${prefix}:${queue}:`). */
export const JOB_KEY = {
  /** the job hash itself */
  hash: (id: string) => id,
  /** list of log lines (RPUSH, oldest first) */
  logs: (id: string) => `${id}:logs`,
  /** set of child job keys still unprocessed (flow parents) */
  dependencies: (id: string) => `${id}:dependencies`,
  /** hash childKey -> returnvalue of processed children (flow parents) */
  processed: (id: string) => `${id}:processed`,
  /** worker lock (string token) */
  lock: (id: string) => `${id}:lock`,
} as const;

/**
 * BullMQ Pro group keys (relative to `${prefix}:${queue}:`).
 *
 * Best knowledge of the layout (not officially documented):
 *  - `groups`            zset  group id -> score (used for fair round-robin ordering)
 *  - `groups:${gid}`     list  waiting job ids of that group
 *  - `groups:active`     zset/set of groups currently being processed
 *  - `groups:paused`     set/zset of paused groups
 *  - `groups:max`        set/zset of groups that hit their max concurrency
 *  - `groups:limit`      zset  rate-limited groups -> score = ms when the limit lifts
 *  - `groups-lid`        string  last group id served (round-robin pointer)
 * The Lua that reads these is written defensively (ZSCORE then SISMEMBER) so a
 * set/zset mismatch degrades to status "unknown" rather than an error.
 */
export const GROUP_KEY = {
  groups: "groups",
  group: (groupId: string) => `groups:${groupId}`,
  active: "groups:active",
  paused: "groups:paused",
  max: "groups:max",
  limit: "groups:limit",
  lastId: "groups-lid",
} as const;

/** Job hash fields that carry the Pro group id (we accept either spelling). */
export const GROUP_ID_FIELDS = ["gid", "groupId"] as const;

/**
 * Job hash fields we read. BullMQ stores attemptsMade as `attemptsMade` in older
 * versions and `atm` in newer ones (see Job.fromJSON) — we ask for both.
 */
export const JOB_SUMMARY_FIELDS = [
  "name",
  "data",
  "opts",
  "timestamp",
  "processedOn",
  "finishedOn",
  "attemptsMade",
  "atm",
  "failedReason",
  "progress",
  "delay",
  "priority",
  "parentKey",
  "parent",
  // `stc` = stalledCounter (Job.fromJSON: `parseInt(json.stc || '0')`). Quantas
  // vezes o job foi recuperado por stall. É o único rastro no job de que ele
  // travou; `stalled` em si é um SET auxiliar, não um estado.
  "stc",
  ...GROUP_ID_FIELDS,
] as const;

/** Order in which the 8 state keys are passed to Lua scripts (queueStats, getJob). */
export const STATE_ORDER: readonly JobState[] = [
  "waiting",
  "active",
  "completed",
  "failed",
  "delayed",
  "prioritized",
  "paused",
  "waiting-children",
] as const;

/** Absolute key of a job state for a queue. */
export function stateKey(prefix: string, queue: string, state: JobState): string {
  return queueKeyPrefix(prefix, queue) + STATE_KEY[state].key;
}

/** The 8 state keys, in STATE_ORDER, absolute. */
export function allStateKeys(prefix: string, queue: string): string[] {
  return STATE_ORDER.map((s) => stateKey(prefix, queue, s));
}

/** Pattern used by discovery: one `meta` hash exists per queue. */
export function metaScanPattern(prefix: string): string {
  return `${prefix}:*:${QUEUE_KEY.meta}`;
}

/**
 * `bull:orders:meta` -> `orders`. Returns null when the key does not belong to
 * this prefix or is not a meta key. Handles queue names containing ':'  and
 * cluster hash tags (`bull:{orders}:meta` -> `{orders}`).
 */
export function parseQueueNameFromMetaKey(prefix: string, key: string): string | null {
  const head = `${prefix}:`;
  const tail = `:${QUEUE_KEY.meta}`;
  if (!key.startsWith(head) || !key.endsWith(tail)) return null;
  const name = key.slice(head.length, key.length - tail.length);
  return name.length > 0 ? name : null;
}

/** `bull:orders` (a parent.queueKey) -> `orders`. Falls back to the raw key if the prefix differs. */
export function queueNameFromQueueKey(prefix: string, qualified: string): string {
  const head = `${prefix}:`;
  return qualified.startsWith(head) ? qualified.slice(head.length) : qualified;
}
