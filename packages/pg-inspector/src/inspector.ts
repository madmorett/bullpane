/**
 * PgInspector: every read of a BullMQ Postgres backend (BullMQ >= 6), and every
 * write through the official bullmq API. Same contract as RedisInspector; see
 * @bullpane/inspector for it and sql.ts for the statements and their cost.
 */
import {
  assertSchemaCompatibility,
  createPostgresBackend,
  Job,
  type JobsOptions,
  Queue,
  SchemaMigrationRequiredError,
  UnrecoverableError,
} from "bullmq";
import pg from "pg";
import {
  EMPTY_COUNTS,
  type BulkJobAction,
  type BulkJobActionResult,
  type BulkJobFailure,
  type DiscoveryStatus,
  type GroupsPage,
  type JobDetail,
  type JobScheduler,
  type JobSearchResult,
  type JobState,
  type JobTreeNode,
  type JobsPage,
  type PostgresServerInfo,
  type PromoteJobResult,
  type QueueMetrics,
  type QueueSetup,
  type SchedulerPromoteMode,
} from "@bullpane/shared";
import {
  globToRegExp,
  type CleanableState,
  type FlowEdgeSample,
  type Inspector,
  type InspectorConnectionConfig,
  type InspectorOptions,
  type JobTreeWalk,
  type MetricsCounters,
  type PingResult,
  type QueueStats,
  type WindowCounts,
  type WindowMetrics,
  type WindowMetricsRequest,
} from "@bullpane/inspector";
import { metricPoints, num, numOrNull, prunesCompleted, rowToDetail, rowToScheduler, rowToSummary, jobKeyOf, queueKeyOf, bullpaneState, progressOf } from "./rows.js";
import type { DetailRow, SchedulerRow, SummaryRow } from "./rows.js";
import { ratesFrom, windowMetricsFrom, type MetricsRow } from "./metrics.js";
import * as SQL from "./sql.js";

const DEFAULTS = {
  discoveryTtlMs: 30_000,
  previewBytes: 2048,
  maxScanPerCall: 1000,
  connectTimeoutMs: 5000,
  listFieldCapBytes: 32 * 1024,
  searchFieldCapBytes: 256 * 1024,
  searchByteBudget: 8 * 1024 * 1024,
};

/**
 * Connections this inspector may hold on the customer's database for reads.
 * The dashboard shares that Postgres with the workers; four is enough to keep
 * a page's parallel reads from queueing behind each other and small enough to
 * never matter next to `max_connections`.
 */
const READ_POOL_MAX = 4;
/** A dashboard read that runs longer than this is cancelled by Postgres itself. */
const STATEMENT_TIMEOUT_MS = 10_000;
/**
 * What the read pool calls itself in pg_stat_activity. Workers name their
 * LISTEN connection `<queue>` or `<queue>:w:<name>`, so this can never be
 * mistaken for a worker.
 */
const APPLICATION_NAME = "bullpane-dashboard";
const STATS_METRIC_POINTS = 60;
const DEFAULT_RATE_WINDOW_MINUTES = 60;
const SETUP_CACHE_MS = 10_000;
/**
 * Queue stats are COUNTs: unlike Redis' LLEN/ZCARD they cost O(rows in the
 * state). Measured on 1M jobs / 20 queues: 60 ms when the visibility map is
 * current (index-only scans), 3.3 s right after a bulk load before autovacuum.
 * So identical reads within this window share one statement: ten open tabs and
 * the alerts engine polling the same queues cost one count, not eleven.
 */
const STATS_CACHE_MS = 2_000;
const DETAIL_LOG_TAIL = 100;
const BULK_CONCURRENCY = 8;
const FORCE_DISCOVERY_MIN_MS = 5_000;
const MAX_TREE_CLIMB = 50;

type ResolvedConfig = Inspector["config"];

/** `"bullmq"` -> `"bullmq"` quoted for search_path, the way BullMQ quotes it (case-preserving). */
function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/** LIKE pattern for a plain substring: `%`, `_` and `\` in the query match themselves. */
function likeSubstring(query: string): string {
  return `%${query.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export class PgInspector implements Inspector {
  readonly config: ResolvedConfig;
  private readonly opts: typeof DEFAULTS;
  private readonly pool: pg.Pool;
  private readonly filter: RegExp | null;
  private ready: Promise<void> | null = null;
  private discovered: { at: number; names: string[] } | null = null;
  private discovering: Promise<string[]> | null = null;
  private readonly setupCache = new Map<string, { at: number; value: QueueSetup }>();
  private readonly statsCache = new Map<string, { at: number; value: Promise<Record<string, QueueStats>> }>();
  /** bullmq Queue per queue name, created lazily for writes only. */
  private readonly queues = new Map<string, Queue>();
  private closed = false;

  constructor(config: InspectorConnectionConfig, options: InspectorOptions = {}) {
    if (config.kind !== "postgres") throw new Error("PgInspector only opens postgres connections");
    this.config = { ...config, kind: "postgres", prefix: config.prefix ?? "bullmq", cluster: false };
    this.opts = { ...DEFAULTS };
    for (const [k, v] of Object.entries(options)) {
      if (v !== undefined && k in DEFAULTS) (this.opts as Record<string, number>)[k] = v as number;
    }
    this.filter = config.queueFilter ? globToRegExp(config.queueFilter) : null;
    this.pool = new pg.Pool({
      connectionString: config.url,
      max: READ_POOL_MAX,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: this.opts.connectTimeoutMs,
      application_name: APPLICATION_NAME,
      // Every connection resolves BullMQ's unqualified table names in the
      // connection's schema, and no read can hold the database for long.
      options: `-c search_path=${quoteIdent(this.config.prefix)} -c statement_timeout=${STATEMENT_TIMEOUT_MS}`,
    });
    // An idle client dropped by the server emits 'error' on the pool; without a
    // listener that crashes the process when a customer database restarts.
    this.pool.on("error", () => undefined);
  }

  // ---------------------------------------------------------------------------
  // connection
  // ---------------------------------------------------------------------------

  /**
   * Once per inspector: the schema exists and was migrated by a BullMQ this
   * version can read (BullMQ's own assertSchemaCompatibility, read only — the
   * dashboard never runs migrations on a customer database). Retried on the
   * next call after a failure.
   */
  private async ensureReady(): Promise<void> {
    if (this.closed) throw new Error("inspector_closed");
    if (!this.ready) {
      this.ready = (async () => {
        const client = await this.pool.connect();
        try {
          await assertSchemaCompatibility(client, this.config.prefix);
        } catch (err) {
          if (err instanceof SchemaMigrationRequiredError) {
            throw new Error(
              `postgres_schema_missing: no BullMQ schema "${this.config.prefix}" in this database. ` +
                "Check the schema name, or start a BullMQ worker with `migrate: true` once.",
            );
          }
          throw err;
        } finally {
          client.release();
        }
      })().catch((err) => {
        this.ready = null;
        throw err;
      });
    }
    return this.ready;
  }

  private async query<R extends pg.QueryResultRow>(text: string, values: unknown[] = []): Promise<R[]> {
    await this.ensureReady();
    const res = await this.pool.query<R>(text, values);
    return res.rows;
  }

  async ping(): Promise<PingResult> {
    const t0 = performance.now();
    try {
      const [row] = await this.query<{ version: string }>(SQL.PING);
      return { ok: true, latencyMs: Math.round((performance.now() - t0) * 10) / 10, redisVersion: row?.version ?? null, error: null };
    } catch (err) {
      return { ok: false, latencyMs: Math.round((performance.now() - t0) * 10) / 10, redisVersion: null, error: errorMessage(err) };
    }
  }

  async serverInfo(): Promise<PostgresServerInfo> {
    const startedAt = Date.now();
    const [r] = await this.query<Record<string, string | number | null>>(SQL.SERVER_INFO);
    const latencyMs = Date.now() - startedAt;
    const hit = numOrNull(r?.blks_hit);
    const read = numOrNull(r?.blks_read);
    const lookups = (hit ?? 0) + (read ?? 0);
    return {
      backend: "postgres",
      serverVersion: String(r?.version ?? "unknown"),
      schema: this.config.prefix,
      uptimeSeconds: num(r?.uptime),
      connectedClients: num(r?.clients),
      maxConnections: num(r?.max_connections),
      databaseSizeBytes: num(r?.db_bytes),
      jobTableBytes: num(r?.job_bytes),
      eventTableBytes: num(r?.event_bytes),
      totalTransactions: numOrNull(r?.transactions),
      cacheHitRatePct: lookups > 0 ? Math.round(((hit ?? 0) / lookups) * 1000) / 10 : null,
      deadlocks: numOrNull(r?.deadlocks),
      latencyMs,
      sampledAt: new Date(startedAt).toISOString(),
    };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await Promise.allSettled([...this.queues.values()].map((q) => q.close()));
    this.queues.clear();
    await this.pool.end().catch(() => undefined);
  }

  // ---------------------------------------------------------------------------
  // discovery
  // ---------------------------------------------------------------------------

  /** `SELECT DISTINCT queue FROM meta`, cached for discoveryTtlMs. See sql.ts. */
  async discoverQueues(opts: { force?: boolean } = {}): Promise<string[]> {
    const age = this.discovered ? Date.now() - this.discovered.at : Number.POSITIVE_INFINITY;
    if (this.discovered && age < (opts.force ? FORCE_DISCOVERY_MIN_MS : this.opts.discoveryTtlMs)) {
      return this.discovered.names;
    }
    if (!this.discovering) {
      this.discovering = this.query<{ queue: string }>(SQL.DISCOVER_QUEUES)
        .then((rows) => {
          const names = rows.map((r) => r.queue).filter((n) => !this.filter || this.filter.test(n));
          names.sort((a, b) => a.localeCompare(b));
          this.discovered = { at: Date.now(), names };
          return names;
        })
        .finally(() => {
          this.discovering = null;
        });
    }
    return this.discovering;
  }

  /** One query lists every queue: discovery is complete from the first call. */
  async discoveryStatus(): Promise<DiscoveryStatus> {
    return { complete: true, scannedIterations: 0, totalKeys: null };
  }

  // ---------------------------------------------------------------------------
  // reads
  // ---------------------------------------------------------------------------

  async getQueueStats(
    queueNames: string[],
    opts: { withMetrics?: boolean; rateWindowMinutes?: number } = {},
  ): Promise<Record<string, QueueStats>> {
    if (queueNames.length === 0) return {};
    const key = JSON.stringify([queueNames, opts.withMetrics === true, opts.rateWindowMinutes ?? null]);
    const now = Date.now();
    const cached = this.statsCache.get(key);
    if (cached && now - cached.at < STATS_CACHE_MS) return cached.value;
    for (const [k, v] of this.statsCache) if (now - v.at >= STATS_CACHE_MS) this.statsCache.delete(k);
    const value = this.readQueueStats(queueNames, opts);
    this.statsCache.set(key, { at: now, value });
    value.catch(() => this.statsCache.delete(key));
    return value;
  }

  private async readQueueStats(
    queueNames: string[],
    opts: { withMetrics?: boolean; rateWindowMinutes?: number },
  ): Promise<Record<string, QueueStats>> {
    const out: Record<string, QueueStats> = {};
    const now = Date.now();
    const windowMinutes = opts.rateWindowMinutes ?? DEFAULT_RATE_WINDOW_MINUTES;
    const points = Math.max(STATS_METRIC_POINTS, windowMinutes);
    const rows = await this.query<Record<string, unknown>>(SQL.QUEUE_STATS, [queueNames, now, points, now - windowMinutes * 60_000]);
    for (const r of rows) {
      const metricsCompleted = metricPoints(r.m_completed_data);
      const metricsFailed = metricPoints(r.m_failed_data);
      const version = typeof r.version === "string" && r.version !== "" ? r.version : null;
      const stats: QueueStats = {
        counts: {
          ...EMPTY_COUNTS,
          waiting: num(r.waiting),
          prioritized: num(r.prioritized),
          active: num(r.active),
          completed: num(r.completed),
          failed: num(r.failed),
          delayed: num(r.delayed),
          "waiting-children": num(r.waiting_children),
        },
        isPaused: r.paused === true,
        isPro: version !== null && version.startsWith("bullmq-pro"),
        groupsCount: 0,
        rates: ratesFrom({
          windowMinutes,
          metricsCompleted,
          metricsFailed,
          totalCompleted: numOrNull(r.m_completed_total),
          totalFailed: numOrNull(r.m_failed_total),
          storedCompleted: num(r.w_completed),
          storedFailed: num(r.w_failed),
          prunesCompleted: prunesCompleted(r.remove_on_complete),
        }),
        library: version,
        schedulersCount: num(r.schedulers),
        stalledCount: num(r.stalled),
      };
      if (opts.withMetrics) {
        stats.metrics = { completed: metricsCompleted.slice(-STATS_METRIC_POINTS), failed: metricsFailed.slice(-STATS_METRIC_POINTS) };
      }
      out[String(r.queue)] = stats;
    }
    return out;
  }

  async getWindowCounts(queueName: string, since: number): Promise<WindowCounts> {
    const [r] = await this.query<{ completed: string; failed: string }>(SQL.WINDOW_COUNTS, [queueName, since]);
    return { completed: num(r?.completed), failed: num(r?.failed) };
  }

  /** The cumulative `count` of the metrics rows; null per side when the row is absent (no metrics). */
  async getMetricsCounters(queueName: string): Promise<MetricsCounters> {
    const collectedAt = Date.now();
    const rows = await this.query<{ kind: string; count: string }>(SQL.METRICS_COUNTERS, [queueName]);
    const read = (kind: string) => numOrNull(rows.find((r) => r.kind === kind)?.count);
    return { completed: read("completed"), failed: read("failed"), collectedAt };
  }

  async getWindowMetrics(
    requests: WindowMetricsRequest[],
    opts: { durationSample?: number; now?: number } = {},
  ): Promise<Record<string, WindowMetrics>> {
    const out: Record<string, WindowMetrics> = {};
    if (requests.length === 0) return out;
    const now = opts.now ?? Date.now();
    const sample = Math.max(1, Math.min(opts.durationSample ?? 100, 100));
    const maxRate = Math.max(1, ...requests.flatMap((r) => r.rateWindows));
    const sinces = requests.map((r) => now - Math.max(0, ...r.durationWindows) * 60_000);
    const rows = await this.query<{ queue: string; metrics: MetricsRow[] | null; durations: Array<[number, number]> | null }>(
      SQL.WINDOW_METRICS,
      [requests.map((r) => r.queue), sinces, maxRate + 1, sample],
    );
    requests.forEach((request, i) => {
      const row = rows[i];
      if (!row) return;
      out[request.queue] = windowMetricsFrom(request, row.metrics, request.durationWindows.length > 0 ? row.durations : null, now);
    });
    return out;
  }

  /**
   * A page of one state: the ids come off the state's partial index (OFFSET over
   * a narrow index, never over full rows), then only that page is joined to
   * `job` for its columns. Total in the same statement.
   */
  async getJobs(
    queueName: string,
    state: JobState,
    opts: { start: number; end: number; order: "asc" | "desc" },
  ): Promise<JobsPage> {
    const s = SQL.STATE_SQL[state];
    if (!s) return { jobs: [], total: 0, start: opts.start, end: opts.end };
    const ob = SQL.orderBy(state, opts.order);
    const limit = Math.max(0, opts.end - opts.start + 1);
    const sql = `
      WITH page AS (
        SELECT id, row_number() OVER (ORDER BY ${ob}) AS ord
        FROM job WHERE queue = $1 AND ${s.where} ORDER BY ${ob} OFFSET $2 LIMIT $3
      )
      SELECT (SELECT count(*) FROM job WHERE queue = $1 AND ${s.where}) AS total,
        (SELECT json_agg(r ORDER BY r.ord) FROM (
           SELECT page.ord, ${SQL.summaryColumns("j", 4, 5)}
           FROM page JOIN job j ON j.queue = $1 AND j.id = page.id) r) AS rows`;
    const [r] = await this.query<{ total: string; rows: SummaryRow[] | null }>(sql, [
      queueName,
      Math.max(0, opts.start),
      limit,
      this.opts.previewBytes,
      this.opts.listFieldCapBytes,
    ]);
    return {
      jobs: (r?.rows ?? []).map((row) => rowToSummary(this.config.prefix, row, this.opts.previewBytes)),
      total: num(r?.total),
      start: opts.start,
      end: opts.end,
    };
  }

  /**
   * Bounded, resumable search, with the same bounds as Redis: at most
   * maxScanPerCall jobs and at most searchByteBudget payload bytes per call, and
   * payloads over searchFieldCapBytes are matched on id / name / error only.
   * Case-insensitive substring (ILIKE with the wildcards escaped). The cursor is
   * the index of the next job to inspect (newest = 0).
   */
  async searchJobs(
    queueName: string,
    state: JobState,
    query: string,
    opts: { cursor?: string | null; limit: number },
  ): Promise<JobSearchResult> {
    const s = SQL.STATE_SQL[state];
    if (!s) return { jobs: [], nextCursor: null, scanned: 0, total: 0, skippedLargePayloads: 0 };
    const cursor = Math.max(0, Math.trunc(Number(opts.cursor ?? 0)) || 0);
    const limit = Math.max(1, opts.limit);
    const ob = SQL.orderBy(state, "desc");
    const sql = `
      WITH scan AS (
        SELECT id, row_number() OVER (ORDER BY ${ob}) AS rn
        FROM job WHERE queue = $1 AND ${s.where} ORDER BY ${ob} OFFSET $2 LIMIT $3
      ), sized AS (
        SELECT s.rn, s.id, pg_column_size(j.data) AS sz
        FROM scan s JOIN job j ON j.queue = $1 AND j.id = s.id
      ), budgeted AS (
        -- a job is inspected when the payload bytes spent BEFORE it are inside the budget
        SELECT rn, id, sz > $6 AS too_big FROM (
          SELECT rn, id, sz, sum(CASE WHEN sz > $6 THEN 0 ELSE sz END) OVER (ORDER BY rn) AS spent FROM sized
        ) b
        WHERE spent - CASE WHEN sz > $6 THEN 0 ELSE sz END < $7
      ), hits AS (
        SELECT b.rn, ${SQL.summaryColumns("j", 8, 9)}
        FROM budgeted b JOIN job j ON j.queue = $1 AND j.id = b.id
        WHERE j.id ILIKE $4 ESCAPE '\\' OR j.name ILIKE $4 ESCAPE '\\' OR j.failed_reason ILIKE $4 ESCAPE '\\'
           OR (NOT b.too_big AND j.data::text ILIKE $4 ESCAPE '\\')
        ORDER BY b.rn LIMIT $5
      )
      SELECT (SELECT count(*) FROM job WHERE queue = $1 AND ${s.where}) AS total,
        (SELECT count(*) FROM budgeted) AS scanned,
        (SELECT json_agg(rn) FROM budgeted WHERE too_big) AS big,
        (SELECT json_agg(h ORDER BY h.rn) FROM hits h) AS rows`;
    const [r] = await this.query<{ total: string; scanned: string; big: number[] | null; rows: Array<SummaryRow & { rn: number }> | null }>(sql, [
      queueName,
      cursor,
      this.opts.maxScanPerCall,
      likeSubstring(query),
      limit,
      this.opts.searchFieldCapBytes,
      this.opts.searchByteBudget,
      this.opts.previewBytes,
      this.opts.listFieldCapBytes,
    ]);
    const total = num(r?.total);
    const rows = r?.rows ?? [];
    // rn is 1-based and absolute (row_number runs before OFFSET), so a job's rn is
    // also the 0-based index of the one after it.
    const stoppedAt = rows.length >= limit ? num(rows[rows.length - 1]?.rn) : cursor + num(r?.scanned);
    const big = (r?.big ?? []).filter((rn) => rn <= stoppedAt).length;
    return {
      jobs: rows.map((row) => rowToSummary(this.config.prefix, row, this.opts.previewBytes)),
      nextCursor: stoppedAt >= total ? null : String(stoppedAt),
      scanned: stoppedAt - cursor,
      total,
      skippedLargePayloads: big,
    };
  }

  async getJob(queueName: string, jobId: string): Promise<JobDetail | null> {
    const [row] = await this.query<DetailRow>(SQL.JOB_DETAIL, [queueName, jobId, DETAIL_LOG_TAIL]);
    return row ? rowToDetail(this.config.prefix, row) : null;
  }

  async getJobLogs(queueName: string, jobId: string, opts: { start: number; end: number }): Promise<{ logs: string[]; count: number }> {
    const start = Math.max(0, opts.start);
    // LRANGE semantics: a negative end means "to the last line".
    const limit = opts.end < 0 ? null : Math.max(0, opts.end - start + 1);
    const [r] = await this.query<{ logs: string[]; count: string }>(SQL.JOB_LOGS, [queueName, jobId, start, limit]);
    return { logs: r?.logs ?? [], count: num(r?.count) };
  }

  async getMetrics(queueName: string, points: number): Promise<QueueMetrics> {
    const rows = await this.query<{ kind: string; data: string[] }>(SQL.METRICS, [queueName, Math.max(1, points)]);
    const read = (kind: string) => metricPoints(rows.find((r) => r.kind === kind)?.data);
    return { completed: read("completed"), failed: read("failed") };
  }

  /**
   * meta + the limiter window + whether metrics are collected, then the workers
   * from pg_stat_activity. Cached SETUP_CACHE_MS, like Redis (pg_stat_activity
   * is cheap, but there is no reason to read it on every poll).
   */
  async getQueueSetup(queueName: string): Promise<QueueSetup> {
    const cached = this.setupCache.get(queueName);
    if (cached && Date.now() - cached.at < SETUP_CACHE_MS) return cached.value;
    const [[r], workers] = await Promise.all([
      this.query<{ meta: Record<string, string | null> | null; limiter_expire_at: string | null; metrics_enabled: boolean }>(SQL.QUEUE_SETUP, [queueName]),
      this.listWorkers(queueName).catch(() => null),
    ]);
    const meta = r?.meta ?? {};
    const version = meta.version ?? null;
    const max = numOrNull(meta.max);
    const duration = numOrNull(meta.duration);
    const expireAt = numOrNull(r?.limiter_expire_at);
    const ttl = expireAt === null ? -1 : expireAt - Date.now();
    const { version: _v, paused: _p, concurrency: _c, max: _m, duration: _d, ...rest } = meta;
    const rawMeta: Record<string, string> = {};
    for (const [k, v] of Object.entries(rest)) if (v !== null && v !== undefined) rawMeta[k] = v;
    const value: QueueSetup = {
      library: version,
      isPro: version !== null && version.startsWith("bullmq-pro"),
      isPaused: meta.paused !== undefined,
      globalConcurrency: numOrNull(meta.concurrency),
      globalRateLimit: max !== null && duration !== null ? { max, durationMs: duration } : null,
      rateLimitedNow: ttl >= 0 ? { ttlMs: ttl } : null,
      workers,
      groups: null,
      batch: "unknown",
      metricsEnabled: r?.metrics_enabled === true,
      maxLenEvents: numOrNull(meta["opts.maxLenEvents"]),
      rawMeta,
    };
    this.setupCache.set(queueName, { at: Date.now(), value });
    return value;
  }

  private async listWorkers(queueName: string): Promise<{ count: number; names: string[] }> {
    const rows = await this.query<{ application_name: string }>(SQL.WORKERS, [
      queueName,
      `${queueName.replace(/[\\%_]/g, (c) => `\\${c}`)}:w:%`,
    ]);
    const names = rows.map((r) => {
      const idx = r.application_name.indexOf(":w:");
      return idx === -1 ? "worker" : r.application_name.slice(idx + 3);
    });
    return { count: names.length, names };
  }

  // --- BullMQ Pro groups: the open-source Postgres backend has no groups ------

  async getGroups(): Promise<GroupsPage> {
    return { groups: [], total: 0, byStatus: { waiting: 0, limited: 0, maxed: 0, paused: 0 } };
  }

  async getGroupJobs(_queueName: string, _groupId: string, opts: { start: number; end: number }): Promise<JobsPage> {
    return { jobs: [], total: 0, start: opts.start, end: opts.end };
  }

  // ---------------------------------------------------------------------------
  // job schedulers
  // ---------------------------------------------------------------------------

  async getSchedulers(queueName: string, opts: { start: number; end: number }): Promise<{ schedulers: JobScheduler[]; total: number }> {
    const limit = opts.end < 0 ? null : Math.max(0, opts.end - opts.start + 1);
    const [r] = await this.query<{ total: string; rows: SchedulerRow[] | null }>(SQL.SCHEDULERS, [
      queueName,
      Math.max(0, opts.start),
      limit,
      this.opts.previewBytes,
    ]);
    return { schedulers: (r?.rows ?? []).map(rowToScheduler), total: num(r?.total) };
  }

  /** Official API: removes the scheduler AND the delayed job it has queued. */
  async removeScheduler(queueName: string, key: string): Promise<{ removed: boolean }> {
    const queue = await this.getQueue(queueName);
    return { removed: (await queue.removeJobScheduler(key)) === true };
  }

  // ---------------------------------------------------------------------------
  // flows
  // ---------------------------------------------------------------------------

  async sampleFlowEdges(queueName: string, opts: { sample?: number } = {}): Promise<{ edges: FlowEdgeSample[]; sampled: number }> {
    const sample = Math.max(1, opts.sample ?? 50);
    const [r] = await this.query<{ sampled: string; edges: Array<[string, number]> | null }>(SQL.SAMPLE_PARENTS, [queueName, sample]);
    const edges = (r?.edges ?? []).map(([parentQueue, count]) => ({ parentQueue, childQueue: queueName, count: num(count) }));
    edges.sort((a, b) => b.count - a.count);
    return { edges, sampled: num(r?.sampled) };
  }

  /**
   * Walk ONE flow instance, breadth first, at most `maxNodes` jobs read. Same
   * shape and budget as the Redis walk, but each wave is ONE statement across
   * every queue it touches (job_dependency holds both ends of every edge).
   */
  async getJobTree(queueName: string, jobId: string, opts: { maxNodes?: number; fromRoot?: boolean } = {}): Promise<JobTreeWalk | null> {
    const maxNodes = Math.max(1, Math.min(opts.maxNodes ?? 200, 500));
    const schema = this.config.prefix;
    let visited = 0;

    const read = async (refs: { queue: string; id: string }[]): Promise<(TreeRow | null)[]> => {
      if (refs.length === 0) return [];
      visited += refs.length;
      const rows = await this.query<TreeRow>(SQL.TREE_NODES, [refs.map((r) => r.queue), refs.map((r) => r.id), maxNodes]);
      return refs.map((_, i) => {
        const row = rows[i];
        return row && row.found ? row : null;
      });
    };

    const [focus] = await read([{ queue: queueName, id: jobId }]);
    if (!focus) return null;
    const focusKey = jobKeyOf(schema, queueName, jobId);

    // 1) climb to the root so a link to a child still shows the whole flow
    let root = { queue: queueName, id: jobId };
    let climbedLevels = 0;
    if (opts.fromRoot !== false) {
      const seen = new Set<string>([focusKey]);
      let current = focus;
      while (current.parent_queue && current.parent_id && climbedLevels < MAX_TREE_CLIMB && visited < maxNodes) {
        const next = { queue: current.parent_queue, id: current.parent_id };
        const key = jobKeyOf(schema, next.queue, next.id);
        if (seen.has(key)) break; // cycle: stop where we are rather than spin
        const [parent] = await read([next]);
        if (!parent) break; // parent was cleaned; the child we have is the best root
        seen.add(key);
        root = next;
        climbedLevels += 1;
        current = parent;
      }
    }

    // 2) breadth first down from the root, one statement per wave
    const nodes = new Map<string, JobTreeNode>();
    let frontier: { queue: string; id: string; parentKey: string | null }[] = [{ ...root, parentKey: null }];
    let truncated = false;
    while (frontier.length > 0 && !truncated) {
      const wave = frontier.filter((f) => !nodes.has(jobKeyOf(schema, f.queue, f.id)));
      const room = maxNodes - nodes.size;
      if (room <= 0) {
        truncated = wave.length > 0;
        break;
      }
      const slice = wave.length > room ? ((truncated = true), wave.slice(0, room)) : wave;
      const rows = await read(slice);
      const next: typeof frontier = [];
      slice.forEach((entry, i) => {
        const key = jobKeyOf(schema, entry.queue, entry.id);
        const row = rows[i] ?? null;
        nodes.set(key, treeNode(schema, entry, row, maxNodes));
        for (const [childQueue, childId] of (row?.children ?? []).slice(0, maxNodes)) {
          const childKey = jobKeyOf(schema, childQueue, childId);
          if (!nodes.has(childKey)) next.push({ queue: childQueue, id: childId, parentKey: key });
        }
      });
      frontier = next;
    }

    return {
      rootKey: jobKeyOf(schema, root.queue, root.id),
      focusKey,
      nodes: [...nodes.values()],
      truncated: truncated || nodes.size >= maxNodes,
      visited,
      climbedLevels,
    };
  }

  // ---------------------------------------------------------------------------
  // writes (official bullmq API; we never write BullMQ's tables ourselves)
  // ---------------------------------------------------------------------------

  /**
   * One bullmq Queue per queue name, created on the first write. BullMQ builds
   * its own pool from the config object (that is the only way it honours a
   * non-default schema); `max: 1` and a short idle timeout keep a dashboard
   * that touched 50 queues from holding 50 connections. A Queue never opens the
   * LISTEN connection — only Workers and QueueEvents do.
   */
  private async getQueue(queueName: string): Promise<Queue> {
    await this.ensureReady();
    this.invalidateStats();
    let q = this.queues.get(queueName);
    if (q) return q;
    q = new Queue(
      queueName,
      {
        connection: {
          connectionString: this.config.url,
          schema: this.config.prefix,
          max: 1,
          idleTimeoutMillis: 10_000,
          application_name: APPLICATION_NAME,
        } as never,
        skipMetasUpdate: true,
      },
      createPostgresBackend as never,
    );
    q.on("error", () => undefined);
    this.queues.set(queueName, q);
    return q;
  }

  /**
   * Every write goes through getQueue, so dropping the stats window here keeps
   * an action from being followed by a count from before it.
   */
  private invalidateStats(): void {
    this.statsCache.clear();
  }

  private async getBullJob(queueName: string, jobId: string): Promise<Job> {
    const queue = await this.getQueue(queueName);
    const job = await Job.fromId(queue, jobId);
    if (!job) throw new Error("job_not_found");
    return job;
  }

  async addJob(queueName: string, name: string, data: unknown, opts: Record<string, unknown> = {}): Promise<{ id: string }> {
    const queue = await this.getQueue(queueName);
    const job = await queue.add(name, data, opts as JobsOptions);
    return { id: String(job.id) };
  }

  async retryJob(queueName: string, jobId: string): Promise<void> {
    const job = await this.getBullJob(queueName, jobId);
    const state = await job.getState();
    if (state !== "failed" && state !== "completed") throw new Error(`cannot_retry_job_in_state_${state}`);
    await job.retry(state);
  }

  async removeJob(queueName: string, jobId: string): Promise<void> {
    const job = await this.getBullJob(queueName, jobId);
    await job.remove();
  }

  /** Same rules as the Redis inspector: a scheduler's job asks the operator first. */
  async promoteJob(queueName: string, jobId: string, scheduler: SchedulerPromoteMode = "run_copy"): Promise<PromoteJobResult> {
    const job = await this.getBullJob(queueName, jobId);
    if (!job.repeatJobKey) {
      await job.promote();
      return { mode: "promoted" };
    }
    if (scheduler === "skip_next") {
      await job.promote();
      return { mode: "skipped_next", schedulerId: job.repeatJobKey };
    }
    const state = await job.getState();
    if (state !== "delayed") throw new Error(`cannot_promote_job_in_state_${state}`);
    const { repeat: _r, jobId: _j, repeatJobKey: _k, prevMillis: _p, delay: _d, timestamp: _t, ...opts } = job.opts as JobsOptions & {
      repeat?: unknown;
      repeatJobKey?: string;
      prevMillis?: number;
    };
    const copy = await this.addJob(queueName, job.name, job.data, opts);
    return { mode: "ran_copy", jobId: copy.id, schedulerId: job.repeatJobKey };
  }

  /** Partial result, bounded concurrency: see Inspector.bulkJobAction. */
  async bulkJobAction(queueName: string, action: BulkJobAction, jobIds: string[]): Promise<BulkJobActionResult> {
    const ok: string[] = [];
    const failed: BulkJobFailure[] = [];
    const ids = [...new Set(jobIds)];
    const run = async (jobId: string): Promise<void> => {
      try {
        if (action === "retry") await this.retryJob(queueName, jobId);
        else if (action === "remove") await this.removeJob(queueName, jobId);
        else await this.promoteJob(queueName, jobId);
        ok.push(jobId);
      } catch (err) {
        failed.push({ jobId, reason: errorMessage(err) });
      }
    };
    for (let i = 0; i < ids.length; i += BULK_CONCURRENCY) {
      await Promise.all(ids.slice(i, i + BULK_CONCURRENCY).map(run));
    }
    return { action, ok, failed, requested: ids.length };
  }

  /** Operator "discard": an active job straight to failed, no retry (see RedisInspector.discardJob). */
  async discardJob(queueName: string, jobId: string): Promise<void> {
    const job = await this.getBullJob(queueName, jobId);
    const state = await job.getState();
    if (state !== "active") throw new Error(`cannot_discard_job_in_state_${state}`);
    try {
      await job.moveToFailed(new UnrecoverableError("Discarded from Bullpane"), "0");
    } catch (err) {
      throw new Error(`cannot_discard_active_job: ${errorMessage(err)}`);
    }
  }

  async pauseQueue(queueName: string): Promise<void> {
    await (await this.getQueue(queueName)).pause();
    this.setupCache.delete(queueName);
    this.statsCache.clear();
  }

  async resumeQueue(queueName: string): Promise<void> {
    await (await this.getQueue(queueName)).resume();
    this.setupCache.delete(queueName);
    this.statsCache.clear();
  }

  async cleanQueue(queueName: string, state: CleanableState, graceMs: number, limit: number): Promise<{ removed: number }> {
    const ids = await (await this.getQueue(queueName)).clean(graceMs, limit, state);
    return { removed: ids.length };
  }

  async retryAll(queueName: string, state: "failed" | "completed"): Promise<void> {
    await (await this.getQueue(queueName)).retryJobs({ state });
  }

  async drainQueue(queueName: string, includeDelayed: boolean): Promise<void> {
    await (await this.getQueue(queueName)).drain(includeDelayed);
  }

  async obliterateQueue(queueName: string): Promise<void> {
    const queue = await this.getQueue(queueName);
    await queue.obliterate({ force: true });
    this.queues.delete(queueName);
    await queue.close().catch(() => undefined);
    this.discovered = null;
  }
}

interface TreeRow {
  ord: string;
  found: boolean;
  name: string | null;
  state: string | null;
  priority: number | null;
  added_at_ms: string | null;
  finished_at_ms: string | null;
  attempts_made: number | null;
  failed_reason: string | null;
  progress: unknown;
  parent_queue: string | null;
  parent_id: string | null;
  unprocessed: string;
  processed: string;
  children: Array<[string, string]> | null;
}

function treeNode(
  schema: string,
  entry: { queue: string; id: string; parentKey: string | null },
  row: TreeRow | null,
  maxNodes: number,
): JobTreeNode {
  const key = jobKeyOf(schema, entry.queue, entry.id);
  const base = { key, id: entry.id, queueName: entry.queue, queueKey: queueKeyOf(schema, entry.queue) };
  if (!row) {
    // a parent still references it but the job row is gone (removed / cleaned)
    return {
      ...base,
      name: "",
      state: "unknown",
      timestamp: 0,
      finishedOn: null,
      attemptsMade: 0,
      failedReason: null,
      progress: null,
      parentKey: entry.parentKey,
      dependencies: null,
      childrenTruncated: false,
      missing: true,
    };
  }
  const processed = num(row.processed);
  const unprocessed = num(row.unprocessed);
  return {
    ...base,
    name: row.name ?? "",
    state: bullpaneState(row.state, row.priority),
    timestamp: num(row.added_at_ms),
    finishedOn: numOrNull(row.finished_at_ms),
    attemptsMade: num(row.attempts_made),
    failedReason: row.failed_reason ?? null,
    progress: progressOf(row.progress),
    // the walk's own edge wins over the stored parent: it is the edge being drawn
    parentKey: entry.parentKey ?? (row.parent_queue && row.parent_id ? jobKeyOf(schema, row.parent_queue, row.parent_id) : null),
    dependencies: processed + unprocessed > 0 ? { processed, unprocessed } : null,
    // TREE_NODES reads maxNodes + 1 children: one more than the walk could hold means there are more
    childrenTruncated: (row.children?.length ?? 0) > maxNodes,
    missing: false,
  };
}
