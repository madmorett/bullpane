/**
 * Postgres rows -> Bullpane DTOs. The same DTOs the Redis inspector produces,
 * so nothing above the Inspector interface knows which backend it reads.
 *
 * node-postgres returns bigint (every `_ms` column, every count) as a string;
 * columns that went through json_agg arrive as JSON numbers. `num` takes both.
 */
import type { JobDetail, JobParentRef, JobScheduler, JobState, JobSummary } from "@bullpane/shared";

export function num(v: unknown, fallback = 0): number {
  if (typeof v === "number") return Number.isFinite(v) ? v : fallback;
  if (typeof v === "string" && v !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
  }
  return fallback;
}

export function numOrNull(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = num(v, Number.NaN);
  return Number.isNaN(n) ? null : n;
}

/**
 * `<schema>:<queue>`: the Postgres spelling of a Redis queue key. The web UI
 * strips the connection's `prefix` (here, the schema) to get the queue name
 * back, so the same parsing works for both backends.
 */
export function queueKeyOf(schema: string, queue: string): string {
  return `${schema}:${queue}`;
}

/** `<schema>:<queue>:<id>`, unique across queues, like a Redis job key. */
export function jobKeyOf(schema: string, queue: string, id: string): string {
  return `${schema}:${queue}:${id}`;
}

/**
 * Postgres keeps the parent as two columns, so nothing is parsed out of a key
 * here (job ids may contain colons, e.g. scheduler jobs `repeat:<key>:<millis>`).
 */
export function parentRef(schema: string, parentQueue: unknown, parentId: unknown): JobParentRef | null {
  if (typeof parentQueue !== "string" || parentQueue === "" || parentId === null || parentId === undefined) return null;
  return { id: String(parentId), queueKey: queueKeyOf(schema, parentQueue), queue: parentQueue };
}

/**
 * Physical state -> Bullpane state. A waiting job with a priority is
 * `prioritized` (BullMQ's own get_counts split). Waiting jobs of a paused queue
 * stay `waiting`: see STATE_SQL.
 */
export function bullpaneState(physical: unknown, priority: unknown): JobState | "unknown" {
  switch (physical) {
    case "waiting":
      return num(priority) > 0 ? "prioritized" : "waiting";
    case "active":
    case "completed":
    case "failed":
    case "delayed":
    case "waiting-children":
      return physical;
    default:
      return "unknown";
  }
}

/** `progress` is jsonb: a number, a string or an object. BullMQ treats a missing one as 0. */
export function progressOf(v: unknown): JobSummary["progress"] {
  if (v === null || v === undefined) return 0;
  if (typeof v === "number" || typeof v === "string") return v;
  if (typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
  return JSON.stringify(v);
}

function attemptsOf(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** A row selected with `summaryColumns()`. */
export interface SummaryRow {
  id: string;
  name: string;
  state: string;
  priority: number | string;
  delay_ms: number | string;
  attempts_made: number;
  added_at_ms: number | string;
  processed_at_ms: number | string | null;
  finished_at_ms: number | string | null;
  process_at_ms: number | string | null;
  failed_reason: string | null;
  progress: unknown;
  opt_attempts: unknown;
  group_id: string | null;
  scheduler_id: string | null;
  stalled_count: number;
  parent_queue: string | null;
  parent_id: string | null;
  data_stored: number;
  data_preview: string | null;
  data_bytes: number | string | null;
}

export function rowToSummary(schema: string, row: SummaryRow, previewBytes: number): JobSummary {
  const state = bullpaneState(row.state, row.priority);
  const read = row.data_preview !== null && row.data_preview !== undefined;
  const bytes = read ? num(row.data_bytes) : num(row.data_stored);
  return {
    id: String(row.id),
    name: row.name ?? "",
    timestamp: num(row.added_at_ms),
    processedOn: numOrNull(row.processed_at_ms),
    finishedOn: numOrNull(row.finished_at_ms),
    attemptsMade: num(row.attempts_made),
    attempts: attemptsOf(row.opt_attempts),
    failedReason: row.failed_reason ?? null,
    progress: progressOf(row.progress),
    delay: num(row.delay_ms),
    // Postgres stores the due time itself (process_at_ms): no score decoding.
    delayedUntil: state === "delayed" ? numOrNull(row.process_at_ms) : null,
    priority: num(row.priority),
    dataPreview: read ? (row.data_preview as string) : "",
    // Above the list cap the payload was not read at all; `dataBytes` is then the
    // stored (possibly compressed) size, which is what pg_column_size can tell
    // without detoasting it.
    dataTruncated: !read || bytes > previewBytes,
    dataBytes: bytes,
    parent: parentRef(schema, row.parent_queue, row.parent_id),
    groupId: row.group_id ?? null,
    repeatJobKey: row.scheduler_id ?? null,
    stalledCounter: num(row.stalled_count),
    state,
  };
}

export interface DetailRow {
  id: string;
  name: string;
  state: string;
  priority: number;
  delay_ms: string | number;
  attempts_made: number;
  added_at_ms: string | number;
  processed_at_ms: string | number | null;
  finished_at_ms: string | number | null;
  process_at_ms: string | number | null;
  failed_reason: string | null;
  progress: unknown;
  data: unknown;
  opts: Record<string, unknown> | null;
  return_value: unknown;
  stacktrace: unknown;
  scheduler_id: string | null;
  stalled_count: number;
  parent_queue: string | null;
  parent_id: string | null;
  data_bytes: string | number | null;
  logs: string[] | null;
  logs_count: string | number;
  unprocessed: string | number;
  processed: string | number;
}

export function rowToDetail(schema: string, row: DetailRow): JobDetail {
  const state = bullpaneState(row.state, row.priority);
  const opts = row.opts && typeof row.opts === "object" ? row.opts : {};
  const group = opts.group as { id?: unknown } | undefined;
  const processed = num(row.processed);
  const unprocessed = num(row.unprocessed);
  return {
    id: String(row.id),
    name: row.name ?? "",
    timestamp: num(row.added_at_ms),
    processedOn: numOrNull(row.processed_at_ms),
    finishedOn: numOrNull(row.finished_at_ms),
    attemptsMade: num(row.attempts_made),
    attempts: attemptsOf(opts.attempts),
    failedReason: row.failed_reason ?? null,
    progress: progressOf(row.progress),
    delay: num(row.delay_ms),
    delayedUntil: state === "delayed" ? numOrNull(row.process_at_ms) : null,
    priority: num(row.priority),
    dataBytes: numOrNull(row.data_bytes),
    parent: parentRef(schema, row.parent_queue, row.parent_id),
    groupId: group && (typeof group.id === "string" || typeof group.id === "number") ? String(group.id) : null,
    repeatJobKey: row.scheduler_id ?? null,
    stalledCounter: num(row.stalled_count),
    state,
    data: row.data ?? null,
    opts,
    returnvalue: row.return_value ?? null,
    stacktrace: stacktraceOf(row.stacktrace),
    logs: row.logs ?? [],
    logsCount: num(row.logs_count),
    dependencies: processed + unprocessed > 0 ? { processed, unprocessed } : null,
  };
}

function stacktraceOf(v: unknown): string[] {
  if (v === null || v === undefined) return [];
  if (Array.isArray(v)) return v.map((s) => (typeof s === "string" ? s : JSON.stringify(s)));
  return [typeof v === "string" ? v : JSON.stringify(v)];
}

export interface SchedulerRow {
  scheduler_id: string;
  name: string | null;
  next_run_ms: number | null;
  pattern: string | null;
  every_ms: number | null;
  tz: string | null;
  offset_ms: number | null;
  limit_count: number | null;
  iteration_count: number | null;
  start_date_ms: number | null;
  end_date_ms: number | null;
  template_data: string | null;
  template_opts: string | null;
}

export function rowToScheduler(row: SchedulerRow): JobScheduler {
  const key = String(row.scheduler_id);
  const name = row.name ?? key; // BullMQ defaults the produced job's name to the scheduler id
  return {
    key,
    name,
    next: numOrNull(row.next_run_ms),
    pattern: row.pattern ?? null,
    every: numOrNull(row.every_ms),
    tz: row.tz ?? null,
    offset: numOrNull(row.offset_ms),
    limit: numOrNull(row.limit_count),
    iterationCount: numOrNull(row.iteration_count),
    startDate: numOrNull(row.start_date_ms),
    endDate: numOrNull(row.end_date_ms),
    template:
      row.template_data !== null || row.template_opts !== null
        ? { name, data: row.template_data ?? null, opts: row.template_opts ?? null }
        : null,
  };
}

/** `removeOnComplete` read straight from jsonb: true only when the queue actually prunes. */
export function prunesCompleted(v: unknown): boolean {
  if (v === undefined || v === null || v === false) return false;
  if (v === true || typeof v === "number") return true;
  if (typeof v === "object") {
    const o = v as { count?: unknown; age?: unknown };
    return typeof o.count === "number" || typeof o.age === "number";
  }
  return false;
}

/** bigint[] (strings) newest first -> numbers oldest first, as QueueMetrics wants. */
export function metricPoints(newestFirst: unknown): number[] {
  if (!Array.isArray(newestFirst)) return [];
  return newestFirst.map((v) => num(v)).reverse();
}
