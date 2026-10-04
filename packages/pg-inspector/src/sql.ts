/**
 * Every SQL statement the Postgres inspector runs, in one place.
 *
 * Read against BullMQ's own schema (bullmq/dist/.../postgres/migrations), which
 * is frozen for all of BullMQ 6 by explicit project policy. The connection's
 * `search_path` is pinned to the BullMQ schema, so names are unqualified.
 *
 * Performance rules, the Postgres reading of ARCHITECTURE.md:
 *  - One statement per read. Multi-queue reads take the queue names as an array
 *    (`unnest($1::text[])`) instead of looping one query per queue.
 *  - Every `job` query pins `state`. All of BullMQ's job indexes are partial and
 *    state-scoped (job_ready_idx, job_finished_idx, ...); a query without the
 *    state predicate falls back to the primary key and reads the whole queue.
 *  - Payloads are truncated in SQL (`left(data::text, n)`) and payloads above the
 *    list cap are never cast to text at all (`pg_column_size` reads the stored
 *    size without detoasting).
 *  - Reads never write. Writes go through the official bullmq API.
 */
import type { JobState } from "@bullpane/shared";

/**
 * How each Bullpane state maps onto BullMQ's physical `job.state`.
 *
 * `prioritized` and `paused` are not physical states in Postgres:
 *  - prioritized = waiting with priority > 0 (the same split as BullMQ's get_counts.sql)
 *  - paused is a queue flag in `meta`, not a place jobs move to. The jobs of a
 *    paused queue stay `waiting` and are shown as waiting, with the queue marked
 *    paused — the same convention BullMQ 6 uses on Redis. `paused` is always empty.
 *
 * `order` lists the columns of the partial index that serves the state, so
 * `ORDER BY` + `OFFSET` walks the index instead of sorting the state.
 */
export const STATE_SQL: Record<JobState, { where: string; order: string[] } | null> = {
  waiting: { where: "state = 'waiting' AND priority = 0", order: ["seq"] }, // job_ready_idx
  prioritized: { where: "state = 'waiting' AND priority > 0", order: ["priority", "seq"] }, // job_ready_idx
  active: { where: "state = 'active'", order: ["seq"] }, // small by nature (bounded by worker concurrency)
  completed: { where: "state = 'completed'", order: ["finished_at_ms"] }, // job_finished_idx
  failed: { where: "state = 'failed'", order: ["finished_at_ms"] }, // job_finished_idx
  delayed: { where: "state = 'delayed'", order: ["process_at_ms"] }, // job_delayed_idx
  "waiting-children": { where: "state = 'waiting-children'", order: ["seq"] }, // job_waiting_children_idx
  paused: null,
};

/** `ORDER BY` for a state. "desc" = newest first, which is what Redis' LRANGE / ZREVRANGE give. */
export function orderBy(state: JobState, order: "asc" | "desc"): string {
  const s = STATE_SQL[state];
  if (!s) throw new Error(`no physical state for ${state}`);
  const dir = order === "asc" ? "ASC" : "DESC";
  return s.order.map((c) => `${c} ${dir}`).join(", ");
}

/**
 * The columns a list row needs. `$PREVIEW` / `$CAP` are replaced with the
 * parameter numbers of the calling statement.
 *
 * `data` above the list cap is not cast to text (that would detoast and copy it):
 * the row carries the stored size instead and the UI links to the job.
 */
export function summaryColumns(alias: string, previewParam: number, capParam: number): string {
  const j = alias;
  return `${j}.id, ${j}.name, ${j}.state::text AS state, ${j}.priority, ${j}.delay_ms, ${j}.attempts_made,
    ${j}.added_at_ms, ${j}.processed_at_ms, ${j}.finished_at_ms, ${j}.process_at_ms, ${j}.failed_reason,
    ${j}.progress, ${j}.opts->'attempts' AS opt_attempts, ${j}.opts #>> '{group,id}' AS group_id,
    ${j}.scheduler_id, ${j}.stalled_count, ${j}.parent_queue, ${j}.parent_id,
    pg_column_size(${j}.data) AS data_stored,
    CASE WHEN pg_column_size(${j}.data) <= $${capParam} THEN left(${j}.data::text, $${previewParam}) END AS data_preview,
    CASE WHEN pg_column_size(${j}.data) <= $${capParam} THEN octet_length(${j}.data::text) END AS data_bytes`;
}

/**
 * Per-queue counts and everything the queue list shows, for MANY queues in one
 * statement. Each count is its own scalar subquery so it is served by the
 * partial index of that state (an index-only scan), rather than one
 * `COUNT(*) FILTER` pass over every row of the queue.
 *
 * $1 queue names · $2 now (ms) · $3 metric points · $4 rate window start (ms) ·
 * $5 per queue (aligned with $1), the states NOT to count this time, comma
 * separated: big counts still fresh in the inspector's cache (see
 * LARGE_COUNT). A skipped count's subquery is never executed (a CASE branch
 * not taken), so a queue with 10M completed jobs costs nothing on most reads.
 */
const count = (state: string, where: string) =>
  `CASE WHEN '${state}' = ANY(string_to_array(q.skip, ',')) THEN NULL ELSE (SELECT count(*) FROM job WHERE queue = q.queue AND ${where}) END`;

export const QUEUE_STATS = `
SELECT q.queue,
  ${count("waiting", "state = 'waiting' AND priority = 0")} AS waiting,
  ${count("prioritized", "state = 'waiting' AND priority > 0")} AS prioritized,
  ${count("active", "state = 'active'")} AS active,
  ${count("completed", "state = 'completed'")} AS completed,
  ${count("failed", "state = 'failed'")} AS failed,
  ${count("delayed", "state = 'delayed'")} AS delayed,
  ${count("waiting-children", "state = 'waiting-children'")} AS waiting_children,
  -- An active job whose lock expired: the worker stopped renewing it. This is
  -- what Redis' stalled SET means, read straight off job_active_idx.
  (SELECT count(*) FROM job WHERE queue = q.queue AND state = 'active' AND locked_until_ms < $2) AS stalled,
  EXISTS (SELECT 1 FROM meta WHERE queue = q.queue AND field = 'paused') AS paused,
  (SELECT value FROM meta WHERE queue = q.queue AND field = 'version') AS version,
  (SELECT count(*) FROM scheduler WHERE queue = q.queue) AS schedulers,
  -- the whole metrics row per side: count, prev_ts and prev_count carry the
  -- current minute, which is not in data until the minute rolls over
  (SELECT json_build_object('kind', kind, 'count', count, 'prevTs', prev_ts, 'prevCount', prev_count, 'data', data[1:$3])
     FROM metrics WHERE queue = q.queue AND kind = 'completed') AS m_completed,
  (SELECT json_build_object('kind', kind, 'count', count, 'prevTs', prev_ts, 'prevCount', prev_count, 'data', data[1:$3])
     FROM metrics WHERE queue = q.queue AND kind = 'failed') AS m_failed,
  (SELECT data[1:$3] FROM metrics WHERE queue = q.queue AND kind = 'completed') AS m_completed_data,
  (SELECT data[1:$3] FROM metrics WHERE queue = q.queue AND kind = 'failed') AS m_failed_data,
  -- Only read when the queue has no metrics (the rate then falls back to stored
  -- rows); a busy queue with metrics would otherwise count an hour of jobs per read.
  CASE WHEN EXISTS (SELECT 1 FROM metrics WHERE queue = q.queue) THEN NULL
       ELSE (SELECT count(*) FROM job WHERE queue = q.queue AND state = 'completed' AND finished_at_ms >= $4) END AS w_completed,
  CASE WHEN EXISTS (SELECT 1 FROM metrics WHERE queue = q.queue) THEN NULL
       ELSE (SELECT count(*) FROM job WHERE queue = q.queue AND state = 'failed' AND finished_at_ms >= $4) END AS w_failed,
  -- removeOnComplete lives in each job's opts; one job tells whether the queue prunes.
  (SELECT opts->'removeOnComplete' FROM job WHERE queue = q.queue AND state = 'completed'
     ORDER BY finished_at_ms DESC LIMIT 1) AS remove_on_complete
FROM unnest($1::text[], $5::text[]) AS q(queue, skip)`;

/**
 * Queues = every queue with a `meta` row ∪ every queue that holds a job.
 *
 * meta alone is not enough: BullMQ writes it when a Queue or Worker is
 * constructed, but a queue fed only by a FlowProducer (children of a flow) has
 * jobs and no meta row until a worker shows up. Obliterate deletes both.
 *
 * The job side is a loose index scan (a recursive CTE that jumps from one queue
 * to the next on the primary key `(queue, id)`): one index probe per queue, so
 * it costs O(queues · log rows) instead of the full scan a DISTINCT would do on
 * a job table with millions of rows. meta is a few rows per queue.
 */
export const DISCOVER_QUEUES = `
WITH RECURSIVE jq AS (
  (SELECT queue FROM job ORDER BY queue LIMIT 1)
  UNION ALL
  SELECT (SELECT j.queue FROM job j WHERE j.queue > jq.queue ORDER BY j.queue LIMIT 1)
  FROM jq WHERE jq.queue IS NOT NULL
)
SELECT queue FROM jq WHERE queue IS NOT NULL
UNION
SELECT DISTINCT queue FROM meta
ORDER BY queue`;

export const PING = `SELECT current_setting('server_version') AS version`;

/**
 * Health picture in one round trip. pg_stat_database is per database, so these
 * numbers cover the whole database BullMQ lives in, not just its schema.
 */
export const SERVER_INFO = `
SELECT current_setting('server_version') AS version,
  extract(epoch FROM now() - pg_postmaster_start_time())::bigint AS uptime,
  (SELECT count(*) FROM pg_stat_activity WHERE datname = current_database()) AS clients,
  current_setting('max_connections')::int AS max_connections,
  pg_database_size(current_database()) AS db_bytes,
  COALESCE(pg_total_relation_size(to_regclass('job')), 0) AS job_bytes,
  COALESCE(pg_total_relation_size(to_regclass('event')), 0) AS event_bytes,
  d.xact_commit + d.xact_rollback AS transactions,
  d.blks_hit, d.blks_read, d.deadlocks
FROM pg_stat_database d
WHERE d.datname = current_database()`;

/** $1 queue, $2 since (ms) */
export const WINDOW_COUNTS = `
SELECT
  (SELECT count(*) FROM job WHERE queue = $1 AND state = 'completed' AND finished_at_ms >= $2) AS completed,
  (SELECT count(*) FROM job WHERE queue = $1 AND state = 'failed' AND finished_at_ms >= $2) AS failed`;

/** $1 queue */
export const METRICS_COUNTERS = `SELECT kind, count FROM metrics WHERE queue = $1`;

/** $1 queue, $2 points. `data` is newest first. */
export const METRICS = `SELECT kind, data[1:$2] AS data FROM metrics WHERE queue = $1`;

/**
 * Metrics rows + a bounded processing-time sample for many queues.
 * $1 queue names · $2 duration-window start per queue (ms, aligned with $1) ·
 * $3 metric points to read · $4 max completed jobs sampled per queue
 */
export const WINDOW_METRICS = `
SELECT q.queue,
  (SELECT json_agg(json_build_object('kind', m.kind, 'count', m.count, 'prevTs', m.prev_ts,
            'prevCount', m.prev_count, 'data', m.data[1:$3]))
     FROM metrics m WHERE m.queue = q.queue) AS metrics,
  (SELECT json_agg(json_build_array(s.finished_at_ms, s.finished_at_ms - s.processed_at_ms))
     FROM (SELECT finished_at_ms, processed_at_ms FROM job
            WHERE queue = q.queue AND state = 'completed' AND finished_at_ms >= q.since
            ORDER BY finished_at_ms DESC LIMIT $4) s
    WHERE s.processed_at_ms IS NOT NULL AND s.finished_at_ms >= s.processed_at_ms) AS durations
FROM unnest($1::text[], $2::bigint[]) AS q(queue, since)`;

/**
 * One job with everything the detail page shows, its log tail, its log count
 * and its children counts.
 * $1 queue · $2 id · $3 log tail
 */
export const JOB_DETAIL = `
SELECT j.id, j.name, j.state::text AS state, j.priority, j.delay_ms, j.attempts_made,
  j.added_at_ms, j.processed_at_ms, j.finished_at_ms, j.process_at_ms, j.failed_reason,
  j.progress, j.data, j.opts, j.return_value, j.stacktrace, j.scheduler_id, j.stalled_count,
  j.parent_queue, j.parent_id, octet_length(j.data::text) AS data_bytes,
  (SELECT array_agg(t.row ORDER BY t.idx)
     FROM (SELECT idx, row FROM job_log WHERE queue = $1 AND job_id = $2 ORDER BY idx DESC LIMIT $3) t) AS logs,
  (SELECT count(*) FROM job_log WHERE queue = $1 AND job_id = $2) AS logs_count,
  (SELECT count(*) FILTER (WHERE status = 'pending') FROM job_dependency
     WHERE parent_queue = $1 AND parent_id = $2) AS unprocessed,
  (SELECT count(*) FILTER (WHERE status <> 'pending') FROM job_dependency
     WHERE parent_queue = $1 AND parent_id = $2) AS processed,
  EXISTS (SELECT 1 FROM meta WHERE queue = $1 AND field = 'paused') AS queue_paused
FROM job j
WHERE j.queue = $1 AND j.id = $2`;

/** $1 queue · $2 id · $3 offset · $4 limit (NULL = to the end) */
export const JOB_LOGS = `
SELECT
  ARRAY(SELECT row FROM job_log WHERE queue = $1 AND job_id = $2 ORDER BY idx OFFSET $3 LIMIT $4) AS logs,
  (SELECT count(*) FROM job_log WHERE queue = $1 AND job_id = $2) AS count`;

/**
 * Queue configuration: the whole meta "hash", the limiter window and whether
 * the queue collects metrics. Workers are read separately (pg_stat_activity).
 * $1 queue
 */
export const QUEUE_SETUP = `
SELECT
  (SELECT json_object_agg(field, value) FROM meta WHERE queue = $1) AS meta,
  (SELECT expire_at_ms FROM rate_limit WHERE queue = $1) AS limiter_expire_at,
  EXISTS (SELECT 1 FROM metrics WHERE queue = $1 AND kind = 'completed') AS metrics_enabled`;

/**
 * BullMQ names each worker's dedicated LISTEN connection through
 * `application_name` (`<queue>` or `<queue>:w:<name>`), the Postgres analogue of
 * CLIENT SETNAME; this is BullMQ's own get_client_list.sql narrowed to one queue.
 * $1 queue · $2 `<queue>:w:%` (LIKE-escaped)
 */
export const WORKERS = `
SELECT application_name FROM pg_stat_activity
WHERE datname = current_database() AND (application_name = $1 OR application_name LIKE $2)`;

/**
 * A page of job schedulers in next-run order, plus the total.
 * $1 queue · $2 offset · $3 limit · $4 template preview bytes
 */
export const SCHEDULERS = `
SELECT
  (SELECT count(*) FROM scheduler WHERE queue = $1) AS total,
  (SELECT json_agg(row_to_json(s)) FROM (
     SELECT scheduler_id, name, next_run_ms, pattern, every_ms, tz, offset_ms, limit_count,
            iteration_count, start_date_ms, end_date_ms,
            left(template_data::text, $4) AS template_data, left(template_opts::text, $4) AS template_opts
       FROM scheduler WHERE queue = $1
      ORDER BY next_run_ms ASC NULLS LAST, scheduler_id
     OFFSET $2 LIMIT $3) s) AS rows`;

/**
 * Which parent queues the newest jobs of a queue point at. Each state is sampled
 * through its own index (newest $2 rows), then aggregated.
 * $1 queue · $2 sample per state
 */
export const SAMPLE_PARENTS = `
WITH sampled AS (
  (SELECT parent_queue FROM job WHERE queue = $1 AND state = 'completed' ORDER BY finished_at_ms DESC LIMIT $2)
  UNION ALL
  (SELECT parent_queue FROM job WHERE queue = $1 AND state = 'failed' ORDER BY finished_at_ms DESC LIMIT $2)
  UNION ALL
  (SELECT parent_queue FROM job WHERE queue = $1 AND state = 'waiting-children' ORDER BY seq DESC LIMIT $2)
  UNION ALL
  (SELECT parent_queue FROM job WHERE queue = $1 AND state = 'waiting' AND priority = 0 ORDER BY seq DESC LIMIT $2)
  UNION ALL
  (SELECT parent_queue FROM job WHERE queue = $1 AND state = 'active' ORDER BY seq DESC LIMIT $2)
  UNION ALL
  (SELECT parent_queue FROM job WHERE queue = $1 AND state = 'delayed' ORDER BY process_at_ms DESC LIMIT $2)
)
SELECT
  (SELECT count(*) FROM sampled) AS sampled,
  (SELECT json_agg(json_build_array(parent_queue, n)) FROM (
     SELECT parent_queue, count(*) AS n FROM sampled WHERE parent_queue IS NOT NULL GROUP BY parent_queue
  ) g) AS edges`;

/**
 * One wave of a flow-tree walk: N jobs, possibly across queues, in ONE
 * statement (Postgres has no cluster slots to respect). Children come from
 * job_dependency, capped at $3 + 1 per node so a 50k-child parent is detected
 * as truncated without reading 50k rows.
 * $1 queues · $2 ids (aligned) · $3 max children per node
 */
export const TREE_NODES = `
SELECT r.ord, j.id IS NOT NULL AS found, j.name, j.state::text AS state, j.priority, j.added_at_ms,
  j.finished_at_ms, j.attempts_made, j.failed_reason, j.progress, j.parent_queue, j.parent_id,
  (SELECT count(*) FILTER (WHERE status = 'pending') FROM job_dependency
     WHERE parent_queue = r.queue AND parent_id = r.id) AS unprocessed,
  (SELECT count(*) FILTER (WHERE status <> 'pending') FROM job_dependency
     WHERE parent_queue = r.queue AND parent_id = r.id) AS processed,
  (SELECT json_agg(json_build_array(c.child_queue, c.child_id)) FROM (
     SELECT child_queue, child_id FROM job_dependency
      WHERE parent_queue = r.queue AND parent_id = r.id
      ORDER BY child_key LIMIT $3 + 1) c) AS children
FROM unnest($1::text[], $2::text[]) WITH ORDINALITY AS r(queue, id, ord)
LEFT JOIN job j ON j.queue = r.queue AND j.id = r.id
ORDER BY r.ord`;
