/**
 * Turn raw BullMQ job hashes (as returned by the Lua scripts) into the shared
 * JobSummary / JobDetail shapes. Pure functions; nothing here talks to Redis.
 *
 * Rule: never throw on malformed JSON. A job with a hand-edited `data` field
 * still has to show up in the dashboard, so bad JSON falls back to the raw string.
 */
import type { JobDetail, JobParentRef, JobState, JobSummary } from "@bullmq-visualizer/shared";
import { GROUP_ID_FIELDS, JOB_SUMMARY_FIELDS, queueNameFromQueueKey } from "./keys.js";
import { isRecord, safeJsonParse, toInt, toIntOrNull } from "./util.js";

/** What Redis hands back from Lua: integers, bulk strings, nil, nested arrays. */
export type LuaReply = string | number | null | LuaReply[];

/** A raw job hash as `field -> value` (all strings; missing = undefined). */
export type RawJobHash = Record<string, string | undefined>;

// ---------------------------------------------------------------------------
// Rows from getJobs.lua / searchJobs.lua: [id, ...JOB_SUMMARY_FIELDS values, truncated]
// ---------------------------------------------------------------------------

export function rowToHash(row: LuaReply[]): { id: string; hash: RawJobHash; truncated: boolean } {
  const id = String(row[0] ?? "");
  const hash: RawJobHash = {};
  JOB_SUMMARY_FIELDS.forEach((field, i) => {
    const v = row[i + 1];
    if (typeof v === "string") hash[field] = v;
    else if (typeof v === "number") hash[field] = String(v);
  });
  const truncated = row[JOB_SUMMARY_FIELDS.length + 1] === 1;
  return { id, hash, truncated };
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
    priority: toInt(hash.priority, 0),
    dataPreview: hash.data ?? "",
    dataTruncated,
    parent: parseParent(prefix, hash),
    groupId: parseGroupId(hash, opts),
    state,
  };
}

export function hashToDetail(
  prefix: string,
  id: string,
  hash: RawJobHash,
  state: JobState | "unknown",
  extra: { logs: string[]; logsCount: number; dependencies: { processed: number; unprocessed: number } | null },
): JobDetail {
  const { dataPreview: _p, dataTruncated: _t, ...summary } = hashToSummary(prefix, id, hash, state, false);
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
