/**
 * Turn raw BullMQ job hashes (as returned by the Lua scripts) into the shared
 * JobSummary / JobDetail shapes. Pure functions; nothing here talks to Redis.
 *
 * Rule: never throw on malformed JSON. A job with a hand-edited `data` field
 * still has to show up in the dashboard, so bad JSON falls back to the raw string.
 */
import type { JobDetail, JobParentRef, JobScheduler, JobState, JobSummary } from "@bullpane/shared";
import { GROUP_ID_FIELDS, JOB_SUMMARY_FIELDS, queueNameFromQueueKey } from "./keys.js";
import { isRecord, safeJsonParse, toInt, toIntOrNull } from "./util.js";

/** What Redis hands back from Lua: integers, bulk strings, nil, nested arrays. */
export type LuaReply = string | number | null | LuaReply[];

/** A raw job hash as `field -> value` (all strings; missing = undefined). */
export type RawJobHash = Record<string, string | undefined>;

// ---------------------------------------------------------------------------
// Rows from getJobs.lua / searchJobs.lua: [id, ...JOB_SUMMARY_FIELDS values, truncated, dataBytes, score]
// ---------------------------------------------------------------------------

export function rowToHash(row: LuaReply[]): { id: string; hash: RawJobHash; truncated: boolean; dataBytes: number | null; score: number | null } {
  const id = String(row[0] ?? "");
  const hash: RawJobHash = {};
  JOB_SUMMARY_FIELDS.forEach((field, i) => {
    const v = row[i + 1];
    if (typeof v === "string") hash[field] = v;
    else if (typeof v === "number") hash[field] = String(v);
  });
  const truncated = row[JOB_SUMMARY_FIELDS.length + 1] === 1;
  const size = row[JOB_SUMMARY_FIELDS.length + 2];
  return { id, hash, truncated, dataBytes: typeof size === "number" ? size : null, score: parseScore(row[JOB_SUMMARY_FIELDS.length + 3]) };
}

/** Zset scores come back from Lua as strings (Redis keeps them as doubles). */
export function parseScore(v: LuaReply | undefined): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && v !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/**
 * When a `delayed` job becomes runnable. BullMQ scores the `delayed` zset with
 * `timestamp * 0x1000 + jobId % 0x1000` (Bull 3 onwards; see addDelayedJob.lua
 * and Scripts.moveToDelayedArgs), so the low 12 bits are a tie-breaker and the
 * rest is the unix ms. Only meaningful for the delayed state.
 */
export function delayedUntilFromScore(state: JobState | "unknown", score: number | null): number | null {
  if (state !== "delayed" || score == null) return null;
  return Math.floor(score / 0x1000);
}

// ---------------------------------------------------------------------------
// Field-level parsers
// ---------------------------------------------------------------------------

export function parseParent(prefix: string, hash: RawJobHash): JobParentRef | null {
  const parsed = hash.parent ? safeJsonParse(hash.parent, null) : null;
  if (isRecord(parsed) && typeof parsed.queueKey === "string") {
    const queueKey = parsed.queueKey;
    return {
      id: String(parsed.id ?? ""),
      queueKey,
      queue: queueNameFromQueueKey(prefix, queueKey),
    };
  }
  // Fallback: parentKey = `${prefix}:${queue}:${id}`
  if (hash.parentKey) {
    const cut = hash.parentKey.lastIndexOf(":");
    if (cut > 0) {
      const queueKey = hash.parentKey.slice(0, cut);
      return {
        id: hash.parentKey.slice(cut + 1),
        queueKey,
        queue: queueNameFromQueueKey(prefix, queueKey),
      };
    }
  }
  return null;
}

export function parseOpts(hash: RawJobHash): Record<string, unknown> {
  const parsed = safeJsonParse(hash.opts, {});
  return isRecord(parsed) ? parsed : {};
}

/** BullMQ Pro: `gid` field on the hash, or `opts.group.id`. */
export function parseGroupId(hash: RawJobHash, opts: Record<string, unknown>): string | null {
  for (const f of GROUP_ID_FIELDS) {
    const v = hash[f];
    if (v) return v;
  }
  const group = opts.group;
  if (isRecord(group) && (typeof group.id === "string" || typeof group.id === "number")) {
    return String(group.id);
  }
  return null;
}

/** `progress` is either a number or arbitrary JSON (bullmq: JSON.parse(progress || '0')). */
export function parseProgress(raw: string | undefined): JobSummary["progress"] {
  if (raw === undefined || raw === "") return 0;
  const parsed = safeJsonParse(raw);
  if (typeof parsed === "number" || typeof parsed === "string") return parsed;
  if (isRecord(parsed)) return parsed;
  return raw;
}

/** `stacktrace` is a JSON array of strings; tolerate anything else. */
export function parseStacktrace(raw: string | undefined): string[] {
  if (!raw) return [];
  const parsed = safeJsonParse(raw, null);
  if (Array.isArray(parsed)) return parsed.map((s) => (typeof s === "string" ? s : JSON.stringify(s)));
  return [raw];
}

function parseAttempts(opts: Record<string, unknown>): number | null {
  const a = opts.attempts;
  return typeof a === "number" && Number.isFinite(a) ? a : null;
}

// ---------------------------------------------------------------------------
// Whole-object builders
// ---------------------------------------------------------------------------

export function hashToSummary(
  prefix: string,
  id: string,
  hash: RawJobHash,
  state: JobState | "unknown",
  dataTruncated: boolean,
  dataBytes: number | null = null,
  /** the job's score in its state zset, when the state is a zset (see delayedUntilFromScore) */
  score: number | null = null,
): JobSummary {
  const opts = parseOpts(hash);
  return {
    id,
    name: hash.name ?? "",
    timestamp: toInt(hash.timestamp, 0),
    processedOn: toIntOrNull(hash.processedOn),
    finishedOn: toIntOrNull(hash.finishedOn),
    // newer bullmq writes `atm`, older `attemptsMade` (see Job.fromJSON)
    attemptsMade: toInt(hash.attemptsMade ?? hash.atm, 0),
    attempts: parseAttempts(opts),
    failedReason: hash.failedReason ?? null,
    progress: parseProgress(hash.progress),
    delay: toInt(hash.delay, 0),
    delayedUntil: delayedUntilFromScore(state, score),
    priority: toInt(hash.priority, 0),
    dataPreview: hash.data ?? "",
    dataTruncated,
    dataBytes,
    parent: parseParent(prefix, hash),
    groupId: parseGroupId(hash, opts),
    // `stc` is BullMQ's stall counter (Job.fromJSON: parseInt(json.stc || '0')).
    // > 0 means a worker lost the lock on this job at some point and the
    // StalledCheck recovered it. Not a state: a history kept on the job itself.
    stalledCounter: toInt(hash.stc, 0),
    state,
  };
}

export function hashToDetail(
  prefix: string,
  id: string,
  hash: RawJobHash,
  state: JobState | "unknown",
  extra: { logs: string[]; logsCount: number; dependencies: { processed: number; unprocessed: number } | null; score?: number | null },
): JobDetail {
  const { dataPreview: _p, dataTruncated: _t, ...summary } = hashToSummary(prefix, id, hash, state, false, hash.data ? Buffer.byteLength(hash.data) : 0, extra.score ?? null);
  return {
    ...summary,
    data: safeJsonParse(hash.data, null),
    opts: parseOpts(hash),
    returnvalue: hash.returnvalue === undefined ? null : safeJsonParse(hash.returnvalue),
    stacktrace: parseStacktrace(hash.stacktrace),
    logs: extra.logs,
    logsCount: extra.logsCount,
    dependencies: extra.dependencies,
  };
}

/** HGETALL flat reply `[k1, v1, k2, v2, ...]` -> hash. */
export function flatToHash(flat: LuaReply[]): RawJobHash {
  const hash: RawJobHash = {};
  for (let i = 0; i + 1 < flat.length; i += 2) {
    const k = flat[i];
    const v = flat[i + 1];
    if (typeof k === "string" && (typeof v === "string" || typeof v === "number")) {
      hash[k] = String(v);
    }
  }
  return hash;
}

export function asArray(reply: LuaReply): LuaReply[] {
  return Array.isArray(reply) ? reply : [];
}

export function asNumber(reply: LuaReply, fallback = 0): number {
  if (typeof reply === "number") return reply;
  if (typeof reply === "string") return toInt(reply, fallback);
  return fallback;
}

export function asStringArray(reply: LuaReply): string[] {
  return asArray(reply).map((v) => (typeof v === "string" ? v : String(v ?? "")));
}

/** Metric points come newest-first from Redis; the shared contract wants oldest-first numbers. */
export function metricPoints(reply: LuaReply): number[] {
  return asStringArray(reply)
    .map((s) => Number(s) || 0)
    .reverse();
}

// ---------------------------------------------------------------------------
// Rows from getSchedulers.lua
// ---------------------------------------------------------------------------

/** Lua returns `false` for a missing hash field; ioredis surfaces that as null. */
function str(v: LuaReply): string | null {
  return typeof v === "string" && v !== "" ? v : typeof v === "number" ? String(v) : null;
}

/**
 * [id, next, name, pattern, every, tz, offset, limit, ic, startDate, endDate,
 *  data, opts, truncated] -> JobScheduler.
 *
 * `data`/`opts` stay as (possibly truncated) JSON strings: a truncated payload is
 * not valid JSON, and the UI shows the template raw anyway.
 */
export function rowToScheduler(row: LuaReply[]): JobScheduler {
  const key = String(row[0] ?? "");
  const name = str(row[2]);
  const data = str(row[11]);
  const opts = str(row[12]);
  return {
    key,
    // BullMQ defaults the produced job's name to the scheduler id.
    name: name ?? key,
    next: toIntOrNull(str(row[1])),
    pattern: str(row[3]),
    every: toIntOrNull(str(row[4])),
    tz: str(row[5]),
    offset: toIntOrNull(str(row[6])),
    limit: toIntOrNull(str(row[7])),
    iterationCount: toIntOrNull(str(row[8])),
    startDate: toIntOrNull(str(row[9])),
    endDate: toIntOrNull(str(row[10])),
    template: data !== null || opts !== null ? { name: name ?? key, data, opts } : null,
  };
}

// ---------------------------------------------------------------------------
// Rows from getTreeNode.lua (flow tree walk)
// ---------------------------------------------------------------------------

/**
 * One job as the tree walk sees it: the few fields the graph renders, plus the
 * child job KEYS to expand next. Deliberately not a JobSummary — the walk reads
 * hundreds of these and never needs `data`.
 */
export interface RawTreeNode {
  name: string | null;
  timestamp: number;
  finishedOn: number | null;
  attemptsMade: number;
  failedReason: string | null;
  progress: number | string | Record<string, unknown> | null;
  /** full key of the parent job, or null on a root */
  parentKey: string | null;
  state: string;
  unprocessed: number;
  processed: number;
  /** full job keys of children, capped inside Lua */
  children: string[];
  childrenTruncated: boolean;
}

/**
 * { fieldsFlat, state, unprocessed, processed, childKeys, truncated } -> RawTreeNode.
 *
 * `fields` is the HMGET in getTreeNode.lua's order:
 *   name, timestamp, finishedOn, processedOn, attemptsMade,
 *   failedReason, progress, parentKey, parent, opts
 */
export function parseTreeNode(reply: LuaReply): RawTreeNode | null {
  if (!Array.isArray(reply)) return null;
  const f = asArray(reply[0]);
  const parentKey = str(f[7]) ?? parentKeyFromJson(str(f[8])) ?? parentKeyFromJson(optsParent(str(f[9])));
  return {
    name: str(f[0]),
    timestamp: toInt(str(f[1]), 0),
    finishedOn: toIntOrNull(str(f[2])),
    attemptsMade: toInt(str(f[4]), 0),
    failedReason: str(f[5]),
    progress: parseProgress(str(f[6]) ?? undefined),
    parentKey,
    state: typeof reply[1] === "string" ? reply[1] : "unknown",
    unprocessed: asNumber(reply[2]),
    processed: asNumber(reply[3]),
    children: asStringArray(reply[4]),
    childrenTruncated: asNumber(reply[5]) === 1,
  };
}

/** `{"id":"1","queueKey":"bull:orders"}` -> `bull:orders:1`. */
function parentKeyFromJson(raw: string | null): string | null {
  if (!raw) return null;
  const parsed = safeJsonParse(raw ?? undefined);
  if (isRecord(parsed) && typeof parsed.id === "string" && typeof parsed.queueKey === "string") {
    return `${parsed.queueKey}:${parsed.id}`;
  }
  return null;
}

/** Older bullmq stashed the parent ref inside `opts.parent`. */
function optsParent(raw: string | null): string | null {
  if (!raw) return null;
  const parsed = safeJsonParse(raw ?? undefined);
  if (isRecord(parsed) && isRecord(parsed.parent)) return JSON.stringify(parsed.parent);
  return null;
}
