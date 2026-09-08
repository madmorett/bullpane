/**
 * RedisInspector: every read of a customer's Redis, and every write through the
 * official bullmq API. See types.ts for the contract and ARCHITECTURE.md for the
 * performance rules each method below cites.
 */
import { Cluster, type Redis } from "ioredis";
import { Job, Queue, type JobsOptions } from "bullmq";
import {
  EMPTY_COUNTS,
  STATE_KEY,
  type BulkJobAction,
  type BulkJobActionResult,
  type BulkJobFailure,
  type DiscoveryStatus,
  GROUP_STATUSES,
  type GroupStatus,
  type GroupSummary,
  type GroupsPage,
  type JobDetail,
  type JobScheduler,
  type JobSearchResult,
  type JobState,
  type JobsPage,
  type JobSummary,
  type QueueCounts,
  type QueueMetrics,
  type RedisServerInfo,
  type QueueRates,
  type QueueSetup,
} from "@bullpane/shared";
import { createBullmqConnection, createReadClient } from "./connection.js";
import {
  GROUP_KEY,
  JOB_KEY,
  JOB_SUMMARY_FIELDS,
  QUEUE_KEY,
  SCHEDULER_KEY,
  STATE_ORDER,
  allStateKeys,
  dropGroupMetaNames,
  metaScanPattern,
  parseQueueNameFromMetaKey,
  queueKeyPrefix,
  queueNameFromQueueKey,
  stateKey,
} from "./keys.js";
import {
  asArray,
  asNumber,
  asStringArray,
  flatToHash,
  hashToDetail,
  hashToSummary,
  metricPoints,
  rowToHash,
  rowToScheduler,
  type LuaReply,
} from "./parse.js";
import { callScript, defineScripts, pipelineScript, type RedisClient } from "./scripts.js";
import type {
  CleanableState,
  FlowEdgeSample,
  Inspector,
  InspectorConnectionConfig,
  InspectorOptions,
  MetricsCounters,
  PingResult,
  QueueStats,
  WindowCounts,
} from "./types.js";
import { errorMessage, globToRegExp, parseRedisInfo, toFloatOrNull, toInt, toIntOrNull, totalKeysFromInfo } from "./util.js";

const DEFAULTS: Required<InspectorOptions> = {
  discoveryTtlMs: 30_000,
  previewBytes: 2048,
  maxScanPerCall: 1000,
  connectTimeoutMs: 5000,
  maxScanIterations: 2000,
  discoveryScanBudgetMs: 1500,
  fullScanIntervalMs: 300_000,
  listFieldCapBytes: 32 * 1024,
  searchFieldCapBytes: 256 * 1024,
  searchByteBudget: 8 * 1024 * 1024,
};

/**
 * SCAN COUNT hint. One SCAN with COUNT 1000 is ~0.3 ms on a 3M-key Redis; with
 * maxScanIterations 2000 a pass covers ~2M keys in well under a second of Redis
 * time, and the cursor carries over to the next pass for bigger keyspaces.
 */
const SCAN_COUNT = 1000;
/** Metric points returned by getQueueStats when withMetrics is set (one per minute). */
const STATS_METRIC_POINTS = 60;
/**
 * How many bulk actions run at the same time. A `Promise.all` of 500 `job.retry()`
 * fires 500 concurrent EVALSHAs and queues commands ahead of the customer's own
 * workload — the opposite of the performance contract. A small window finishes in
 * about the same time and keeps Redis breathing.
 */
const BULK_CONCURRENCY = 8;
/** Trailing window for QueueRates (success / failure %). */
const DEFAULT_RATE_WINDOW_MINUTES = 60;
/**
 * A forced discovery (`?refresh=1`) re-runs the SCAN cycle, which is ~0.7 s of
 * Redis time on a 1.3M-key keyspace. Twenty clients clicking refresh in a loop
 * turned that into a steady 40% of a Redis core in the stress test, so a forced
 * pass is honoured at most this often; in between the cached list is returned.
 */
const FORCE_DISCOVERY_MIN_MS = 5_000;
/** getQueueSetup cache TTL: CLIENT LIST is O(clients), so never hammer it. */
const SETUP_CACHE_MS = 10_000;
/** Log lines shipped with job detail. More are available through getJobLogs. */
const DETAIL_LOG_TAIL = 100;
/** States sampled by sampleFlowEdges, newest first. */
const FLOW_SAMPLE_STATES: readonly JobState[] = ["completed", "failed", "waiting-children", "waiting", "active", "delayed"];

type ResolvedConfig = Inspector["config"];

export class RedisInspector implements Inspector {
  readonly config: ResolvedConfig;
  private readonly opts: Required<InspectorOptions>;
  private readonly client: RedisClient;
  private readonly filter: RegExp | null;

  private discovered: { at: number; names: string[] } | null = null;

  /** incremental SCAN state for discovery; see discoverQueues */

  private readonly scan = {

    known: new Set<string>(),

    cursors: new Map<string, string>(),

    doneNodes: new Set<string>(),

    iterationsThisCycle: 0,

    completedCycles: 0,

    lastCycleEndAt: 0,

  };
  private readonly setupCache = new Map<string, { at: number; value: QueueSetup }>();
  private discovering: Promise<string[]> | null = null;

  /** bullmq Queue per queue name, created lazily for writes only. */
  private readonly queues = new Map<string, Queue>();
  /** In cluster mode bullmq gets its own Cluster client, which we own. */
  private bullmqCluster: Cluster | null = null;
  private closed = false;

  constructor(config: InspectorConnectionConfig, options: InspectorOptions = {}) {
    this.config = {
      ...config,
      prefix: config.prefix ?? "bull",
      cluster: config.cluster ?? false,
    };
    this.opts = { ...DEFAULTS, ...stripUndefined(options) };
    this.filter = config.queueFilter ? globToRegExp(config.queueFilter) : null;
    this.client = createReadClient(this.config, this.opts.connectTimeoutMs);
    // Swallow error events: every command already rejects with the same error; an
    // unhandled 'error' event would crash the process when a customer Redis dies.
    this.client.on("error", () => undefined);
    defineScripts(this.client);
  }

  // ---------------------------------------------------------------------------
  // connection
  // ---------------------------------------------------------------------------

  /**
   * lazyConnect + enableOfflineQueue:false means commands are rejected unless the
   * socket is ready, so every public method awaits this first. It connects on first
   * use and otherwise waits (bounded by connectTimeout) for the reconnect in flight.
   */
  private async ensureConnected(): Promise<RedisClient> {
    if (this.closed) throw new Error("inspector_closed");
    const c = this.client;
    if (c.status === "ready") return c;
    if (c.status === "wait") {
      await c.connect();
      return c;
    }
    if (c.status === "end") throw new Error("redis_connection_ended");
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error("redis_unavailable"));
      }, this.opts.connectTimeoutMs);
      const onReady = () => {
        cleanup();
        resolve();
      };
      const onError = (err: Error) => {
        cleanup();
        reject(err);
      };
      const cleanup = () => {
        clearTimeout(timer);
        c.off("ready", onReady);
        c.off("error", onError);
        c.off("end", onError);
      };
      c.once("ready", onReady);
      c.once("error", onError);
      c.once("end", onError);
    });
    return c;
  }

  async ping(): Promise<PingResult> {
    const t0 = performance.now();
    try {
      const c = await this.ensureConnected();
      await c.ping();
      const latencyMs = Math.round((performance.now() - t0) * 10) / 10;
      const info = parseRedisInfo(await c.info("server"));
      return { ok: true, latencyMs, redisVersion: info.redis_version ?? null, error: null };
    } catch (err) {
      return {
        ok: false,
        latencyMs: Math.round((performance.now() - t0) * 10) / 10,
        redisVersion: null,
        error: errorMessage(err),
      };
    }
  }

  /**
   * One INFO round trip, parsed into the health picture. INFO is O(1) and cheap
   * enough to poll every few seconds; it is what redis-cli itself uses. The
   * cumulative counters (commands, CPU) are returned raw — the server turns
   * them into rates by diffing consecutive samples.
   */
  async serverInfo(): Promise<RedisServerInfo> {
    const c = await this.ensureConnected();
    const startedAt = Date.now();
    const info = parseRedisInfo(await c.info());
    const latencyMs = Date.now() - startedAt;
    const maxmemory = toInt(info.maxmemory, 0);
    const hits = toFloatOrNull(info.keyspace_hits);
    const misses = toFloatOrNull(info.keyspace_misses);
    const lookups = (hits ?? 0) + (misses ?? 0);
    const cpuSys = toFloatOrNull(info.used_cpu_sys);
    const cpuUser = toFloatOrNull(info.used_cpu_user);
    const rdbOk = info.rdb_last_bgsave_status;
    const aofOk = info.aof_last_write_status;
    const persistenceOk =
      rdbOk === undefined && aofOk === undefined
        ? null
        : (rdbOk === undefined || rdbOk === "ok") && (aofOk === undefined || aofOk === "ok");
    return {
      usedMemoryRssBytes: toIntOrNull(info.used_memory_rss),
      usedMemoryPeakBytes: toIntOrNull(info.used_memory_peak),
      memFragmentationRatio: toFloatOrNull(info.mem_fragmentation_ratio),
      maxMemoryPolicy: info.maxmemory_policy ?? null,
      cpuSecondsTotal: cpuSys === null && cpuUser === null ? null : (cpuSys ?? 0) + (cpuUser ?? 0),
      blockedClients: toIntOrNull(info.blocked_clients),
      totalCommandsProcessed: toIntOrNull(info.total_commands_processed),
      keyspaceHitRatePct: lookups > 0 ? Math.round(((hits ?? 0) / lookups) * 1000) / 10 : null,
      evictedKeys: toIntOrNull(info.evicted_keys),
      expiredKeys: toIntOrNull(info.expired_keys),
      rejectedConnections: toIntOrNull(info.rejected_connections),
      connectedReplicas: toIntOrNull(info.connected_slaves),
      persistenceOk,
      latencyMs,
      sampledAt: new Date(startedAt).toISOString(),
      redisVersion: info.redis_version ?? "unknown",
      mode: info.redis_mode ?? (this.config.cluster ? "cluster" : "standalone"),
      uptimeSeconds: toInt(info.uptime_in_seconds, 0),
      connectedClients: toInt(info.connected_clients, 0),
      usedMemoryBytes: toInt(info.used_memory, 0),
      usedMemoryHuman: info.used_memory_human ?? "",
      maxMemoryBytes: maxmemory > 0 ? maxmemory : null,
      totalKeys: totalKeysFromInfo(info),
      opsPerSec: toIntOrNull(info.instantaneous_ops_per_sec),
    };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await Promise.allSettled([...this.queues.values()].map((q) => q.close()));
    this.queues.clear();
    if (this.bullmqCluster) {
      await this.bullmqCluster.quit().catch(() => this.bullmqCluster?.disconnect());
      this.bullmqCluster = null;
    }
    if (this.client.status === "wait" || this.client.status === "end") {
      this.client.disconnect();
    } else {
      await this.client.quit().catch(() => this.client.disconnect());
    }
  }

  // ---------------------------------------------------------------------------
  // discovery
  // ---------------------------------------------------------------------------

  /**
   * Which queues exist = SCAN for `${prefix}:*:meta` ∪ the queues whose workers
   * are connected right now (CLIENT LIST names), minus names whose meta key is
   * gone. Cached for discoveryTtlMs; concurrent callers share one in-flight pass.
   *
   * The SCAN is incremental: each pass spends at most maxScanIterations /
   * discoveryScanBudgetMs and keeps its cursor, so on a Redis with millions of
   * keys the first full cycle may take a few passes (see discoveryStatus) while
   * every queue with a live worker is listed from the very first call. After a
   * full cycle the SCAN runs again only every fullScanIntervalMs, or on `force`.
   */
  async discoverQueues(opts: { force?: boolean } = {}): Promise<string[]> {
    const now = Date.now();
    const age = this.discovered ? now - this.discovered.at : Number.POSITIVE_INFINITY;
    if (this.discovered && age < (opts.force ? FORCE_DISCOVERY_MIN_MS : this.opts.discoveryTtlMs)) {
      return this.discovered.names;
    }
    if (!this.discovering) {
      this.discovering = this.refreshDiscovery(opts.force === true)
        .then((names) => {
          this.discovered = { at: Date.now(), names };
          return names;
        })
        .finally(() => {
          this.discovering = null;
        });
    }
    return this.discovering;
  }

  async discoveryStatus(): Promise<DiscoveryStatus> {
    let totalKeys: number | null = null;
    try {
      const c = await this.ensureConnected();
      // DBSIZE is O(1); in cluster mode sum the masters.
      const nodes: Redis[] = c instanceof Cluster ? c.nodes("master") : [c];
      const sizes = await Promise.all(nodes.map((n) => n.dbsize()));
      totalKeys = sizes.reduce((a, b) => a + b, 0);
    } catch {
      totalKeys = null;
    }
    return { complete: this.scan.completedCycles > 0, scannedIterations: this.scan.iterationsThisCycle, totalKeys };
  }

  /** One discovery pass: verify what we know, advance the SCAN if due, add worker queues. */
  private async refreshDiscovery(force: boolean): Promise<string[]> {
    const c = await this.ensureConnected();
    await this.dropVanished(c);
    const now = Date.now();
    const scanDue = force || this.scan.completedCycles === 0 || now - this.scan.lastCycleEndAt >= this.opts.fullScanIntervalMs;
    if (scanDue) await this.advanceScan(c);
    for (const name of await this.queueNamesFromClients(c)) this.scan.known.add(name);
    const names = [...this.scan.known].filter((n) => !this.filter || this.filter.test(n));
    return dropGroupMetaNames(names).sort((a, b) => a.localeCompare(b));
  }

  /** EXISTS on every known meta key, one pipeline: O(#queues), and it keeps deleted queues from lingering. */
  private async dropVanished(c: RedisClient): Promise<void> {
    if (this.scan.known.size === 0) return;
    const names = [...this.scan.known];
    const pipe = c.pipeline();
    for (const n of names) pipe.exists(queueKeyPrefix(this.config.prefix, n) + QUEUE_KEY.meta);
    const res = (await pipe.exec()) ?? [];
    names.forEach((n, i) => {
      const [err, v] = res[i] ?? [null, 1];
      if (!err && v === 0) this.scan.known.delete(n);
    });
  }

  /**
   * Continue the SCAN cycle from the stored cursors until every node wraps to "0"
   * (cycle complete) or the pass budget runs out. In cluster mode SCAN is per
   * node; every master owns a disjoint slice of the keyspace.
   */
  private async advanceScan(c: RedisClient): Promise<void> {
    const nodes: Redis[] = c instanceof Cluster ? c.nodes("master") : [c];
    const pattern = metaScanPattern(this.config.prefix);
    const deadline = Date.now() + this.opts.discoveryScanBudgetMs;
    let budget = this.opts.maxScanIterations;
    for (const node of nodes) {
      const key = `${node.options.host}:${node.options.port}`;
      let cursor = this.scan.cursors.get(key) ?? "0";
      if (this.scan.doneNodes.has(key)) continue;
      while (budget > 0 && Date.now() < deadline) {
        const [next, keys] = await node.scan(cursor, "MATCH", pattern, "COUNT", SCAN_COUNT);
        cursor = next;
        budget -= 1;
        this.scan.iterationsThisCycle += 1;
        for (const k of keys) {
          const name = parseQueueNameFromMetaKey(this.config.prefix, k);
          if (name) this.scan.known.add(name);
        }
        if (cursor === "0") {
          this.scan.doneNodes.add(key);
          break;
        }
      }
      this.scan.cursors.set(key, cursor);
      if (budget <= 0 || Date.now() >= deadline) break;
    }
    if (nodes.every((n) => this.scan.doneNodes.has(`${n.options.host}:${n.options.port}`))) {
      this.scan.completedCycles += 1;
      this.scan.lastCycleEndAt = Date.now();
      this.scan.iterationsThisCycle = 0;
      this.scan.cursors.clear();
      this.scan.doneNodes.clear();
    }
  }

  /**
   * BullMQ workers announce themselves with CLIENT SETNAME `${prefix}:${base64(queue)}`
   * (older versions: the raw queue name), optionally followed by `:w:${workerName}`.
   * CLIENT LIST is O(clients) and finds every queue that is being worked on right
   * now even when the SCAN has not reached its meta key yet. Both spellings are
   * tried and only names whose meta key exists are kept.
   */
  private async queueNamesFromClients(c: RedisClient): Promise<string[]> {
    const head = `${this.config.prefix}:`;
    const nodes: Redis[] = c instanceof Cluster ? c.nodes("master") : [c];
    const raws = await Promise.all(nodes.map((n) => n.client("LIST").then((r) => String(r)).catch(() => "")));
    const candidates = new Set<string>();
    for (const raw of raws) {
      for (const line of raw.split("\n")) {
        const name = /(?:^|\s)name=(\S*)/.exec(line)?.[1] ?? "";
        if (!name.startsWith(head)) continue;
        let body = name.slice(head.length);
        const w = body.indexOf(":w:");
        if (w !== -1) body = body.slice(0, w);
        if (!body) continue;
        candidates.add(body);
        try {
          const decoded = Buffer.from(body, "base64").toString("utf8");
          if (decoded && Buffer.from(decoded, "utf8").toString("base64").replace(/=+$/, "") === body.replace(/=+$/, "")) candidates.add(decoded);
        } catch {
          /* not base64 */
        }
      }
    }
    if (candidates.size === 0) return [];
    const list = [...candidates];
    const pipe = c.pipeline();
    for (const n of list) pipe.exists(queueKeyPrefix(this.config.prefix, n) + QUEUE_KEY.meta);
    const res = (await pipe.exec()) ?? [];
    return list.filter((_, i) => res[i]?.[1] === 1);
  }

  private invalidateDiscovery(): void {
    this.discovered = null;
  }

  // ---------------------------------------------------------------------------
  // reads
  // ---------------------------------------------------------------------------

  private statsKeys(queue: string): string[] {
    const p = queueKeyPrefix(this.config.prefix, queue);
    return [
      ...allStateKeys(this.config.prefix, queue),
      p + QUEUE_KEY.meta,
      p + GROUP_KEY.groups,
      p + QUEUE_KEY.metricsCompletedData,
      p + QUEUE_KEY.metricsFailedData,
      p + QUEUE_KEY.metricsCompleted,
      p + QUEUE_KEY.metricsFailed,
      // job schedulers: a ZCARD on `repeat` for the tab badge, O(1).
      p + QUEUE_KEY.repeat,
      // stalled: an O(1) SCARD. Not a state (BullMQ returns `active` for a stalled
      // job); it is the only way for the UI to say how many of the `active` ones hung.
      p + QUEUE_KEY.stalled,
    ];
  }

  /**
   * One EVALSHA per queue, all in ONE pipeline (single round trip). In cluster mode
   * ioredis refuses multi-slot pipelines, so we fall back to parallel single calls.
   */
  async getQueueStats(
    queueNames: string[],
    opts: { withMetrics?: boolean; rateWindowMinutes?: number } = {},
  ): Promise<Record<string, QueueStats>> {
    const out: Record<string, QueueStats> = {};
    if (queueNames.length === 0) return out;
    const c = await this.ensureConnected();
    const withMetrics = opts.withMetrics ? 1 : 0;
    const windowMinutes = opts.rateWindowMinutes ?? DEFAULT_RATE_WINDOW_MINUTES;
    const since = Date.now() - windowMinutes * 60_000;

    let replies: Array<LuaReply | null>;
    if (c instanceof Cluster) {
      replies = await Promise.all(
        queueNames.map((q) =>
          callScript(c, "queueStats", [...this.statsKeys(q), withMetrics, STATS_METRIC_POINTS, since, queueKeyPrefix(this.config.prefix, q)]).catch(() => null),
        ),
      );
    } else {
      const pipeline = c.pipeline();
      for (const q of queueNames) {
        pipelineScript(pipeline, "queueStats", [...this.statsKeys(q), withMetrics, STATS_METRIC_POINTS, since, queueKeyPrefix(this.config.prefix, q)]);
      }
      const results = (await pipeline.exec()) ?? [];
      replies = results.map(([err, reply]) => (err ? null : (reply as LuaReply)));
    }

    queueNames.forEach((name, i) => {
      const reply = replies[i];
      if (reply === null || reply === undefined) return; // script error for this queue: leave it out
      out[name] = parseStats(reply, withMetrics === 1, windowMinutes);
    });
    return out;
  }

  async getWindowCounts(queueName: string, since: number): Promise<WindowCounts> {
    const c = await this.ensureConnected();
    const p = this.config.prefix;
    // completed/failed zset scores are finishedOn (unix ms), so ZCOUNT is the window.
    const [completed, failed] = await Promise.all([
      c.zcount(stateKey(p, queueName, "completed"), since, "+inf"),
      c.zcount(stateKey(p, queueName, "failed"), since, "+inf"),
    ]);
    return { completed: Number(completed), failed: Number(failed) };
  }

  /**
   * The ONLY honest source for "how many jobs finished": BullMQ's cumulative
   * counters. `HGET metrics:completed count` + `HGET metrics:failed count`, both
   * keys of the same queue, in ONE pipeline => one round trip, cluster safe, O(1)
   * each. No new Lua script: two HGETs are cheaper than an EVALSHA round trip and
   * this is called once per (queue, tick).
   *
   * A missing hash (null) means the Worker was created without
   * `metrics: { maxDataPoints }`. The caller must treat that as "cannot measure",
   * never as zero: zero would read as a perfectly healthy queue.
   */
  async getMetricsCounters(queueName: string): Promise<MetricsCounters> {
    const c = await this.ensureConnected();
    const p = queueKeyPrefix(this.config.prefix, queueName);
    const collectedAt = Date.now();
    // Cluster: both keys carry the queue's hash tag, so a pipeline is single-slot.
    const results =
      (await c
        .pipeline()
        .hget(p + QUEUE_KEY.metricsCompleted, "count")
        .hget(p + QUEUE_KEY.metricsFailed, "count")
        .exec()) ?? [];
    const read = (i: number): number | null => {
      const entry = results[i];
      if (!entry || entry[0]) return null; // pipeline error for this key: unknown, not zero
      return toIntOrNull(typeof entry[1] === "string" ? entry[1] : null);
    };
    return { completed: read(0), failed: read(1), collectedAt };
  }

  async getJobs(
    queueName: string,
    state: JobState,
    opts: { start: number; end: number; order: "asc" | "desc" },
  ): Promise<JobsPage> {
    const key = stateKey(this.config.prefix, queueName, state);
    return this.readPage(queueName, [key], STATE_KEY[state].type, state, opts);
  }

  /** `keys` is the state key, or for a Pro group its list followed by its `:p` zset. */
  private async readPage(
    queueName: string,
    keys: string[],
    type: "list" | "zset",
    state: JobState | "unknown",
    opts: { start: number; end: number; order: "asc" | "desc" },
  ): Promise<JobsPage> {
    const c = await this.ensureConnected();
    const reply = asArray(
      await callScript(c, "getJobs", [
        keys.length,
        ...keys,
        type,
        opts.start,
        opts.end,
        opts.order,
        queueKeyPrefix(this.config.prefix, queueName),
        this.opts.previewBytes,
        this.opts.listFieldCapBytes,
        ...JOB_SUMMARY_FIELDS,
      ]),
    );
    return {
      jobs: asArray(reply[1]).map((row) => this.rowToSummary(row, state)),
      total: asNumber(reply[0]),
      start: opts.start,
      end: opts.end,
    };
  }

  private rowToSummary(row: LuaReply, state: JobState | "unknown"): JobSummary {
    const { id, hash, truncated, dataBytes } = rowToHash(asArray(row));
    return hashToSummary(this.config.prefix, id, hash, state, truncated, dataBytes);
  }

  /**
   * Bounded, resumable search: at most maxScanPerCall hashes AND at most
   * searchByteBudget payload bytes per call (payloads over searchFieldCapBytes
   * are not read at all), plain substring match done in Lua. The cursor is the
   * index of the next job (newest = 0). Measured: 1000 × 1 MB jobs used to hold
   * Redis for 13 s per call; both bounds keep a call in the milliseconds.
   */
  async searchJobs(
    queueName: string,
    state: JobState,
    query: string,
    opts: { cursor?: string | null; limit: number },
  ): Promise<JobSearchResult> {
    const c = await this.ensureConnected();
    const cursor = Math.max(0, toInt(opts.cursor ?? "0", 0));
    const reply = asArray(
      await callScript(c, "getJobsSearch", [
        stateKey(this.config.prefix, queueName, state),
        STATE_KEY[state].type,
        cursor,
        this.opts.maxScanPerCall,
        query.toLowerCase(),
        Math.max(1, opts.limit),
        queueKeyPrefix(this.config.prefix, queueName),
        this.opts.previewBytes,
        this.opts.searchFieldCapBytes,
        this.opts.searchByteBudget,
        ...JOB_SUMMARY_FIELDS,
      ]),
    );
    const next = asNumber(reply[1], -1);
    return {
      jobs: asArray(reply[0]).map((row) => this.rowToSummary(row, state)),
      nextCursor: next < 0 ? null : String(next),
      scanned: asNumber(reply[2]),
      total: asNumber(reply[3]),
      skippedLargePayloads: asNumber(reply[4]),
    };
  }

  async getJob(queueName: string, jobId: string): Promise<JobDetail | null> {
    const c = await this.ensureConnected();
    const p = queueKeyPrefix(this.config.prefix, queueName);
    const reply = await callScript(c, "getJob", [
      p + JOB_KEY.hash(jobId),
      p + JOB_KEY.logs(jobId),
      p + JOB_KEY.dependencies(jobId),
      p + JOB_KEY.processed(jobId),
      ...allStateKeys(this.config.prefix, queueName),
      jobId,
      DETAIL_LOG_TAIL,
    ]);
    if (!Array.isArray(reply)) return null;
    const hash = flatToHash(asArray(reply[0]));
    const unprocessed = asNumber(reply[3]);
    const processed = asNumber(reply[4]);
    const stateRaw = typeof reply[5] === "string" ? reply[5] : "unknown";
    const state = isJobState(stateRaw) ? stateRaw : "unknown";
    return hashToDetail(this.config.prefix, jobId, hash, state, {
      logs: asStringArray(reply[1]),
      logsCount: asNumber(reply[2]),
      dependencies: processed + unprocessed > 0 ? { processed, unprocessed } : null,
    });
  }

  async getJobLogs(
    queueName: string,
    jobId: string,
    opts: { start: number; end: number },
  ): Promise<{ logs: string[]; count: number }> {
    const c = await this.ensureConnected();
    const key = queueKeyPrefix(this.config.prefix, queueName) + JOB_KEY.logs(jobId);
    const [logs, count] = await Promise.all([c.lrange(key, opts.start, opts.end), c.llen(key)]);
    return { logs, count };
  }

  /** Metric lists are LPUSHed (newest at index 0); we return oldest first. */
  async getMetrics(queueName: string, points: number): Promise<QueueMetrics> {
    const c = await this.ensureConnected();
    const p = queueKeyPrefix(this.config.prefix, queueName);
    const n = Math.max(1, points);
    const [completed, failed] = await Promise.all([
      c.lrange(p + QUEUE_KEY.metricsCompletedData, 0, n - 1),
      c.lrange(p + QUEUE_KEY.metricsFailedData, 0, n - 1),
    ]);
    return { completed: metricPoints(completed), failed: metricPoints(failed) };
  }

  // ---------------------------------------------------------------------------
  // BullMQ Pro groups (read only)
  // ---------------------------------------------------------------------------

  /**
   * Everything Redis knows about how a queue is configured: the meta hash
   * (library version, global concurrency, global rate limit, paused), whether a
   * worker rate limiter is throttling right now (limiter key TTL), Pro group
   * settings, and the workers connected (CLIENT LIST names, like bullmq's own
   * getWorkers()). Worker concurrency and batch size are worker-side options
   * that never reach Redis, so they are reported as unknown, not guessed.
   * Cached for SETUP_CACHE_MS because CLIENT LIST is O(number of clients).
   */
  async getQueueSetup(queueName: string): Promise<QueueSetup> {
    const cached = this.setupCache.get(queueName);
    if (cached && Date.now() - cached.at < SETUP_CACHE_MS) return cached.value;

    const c = await this.ensureConnected();
    const p = queueKeyPrefix(this.config.prefix, queueName);
    const [reply, workers] = await Promise.all([
      callScript(c, "queueSetup", [
        p + QUEUE_KEY.meta,
        p + QUEUE_KEY.limiter,
        p + GROUP_KEY.groups,
        p + GROUP_KEY.limit,
        p + GROUP_KEY.max,
        p + GROUP_KEY.paused,
        p + GROUP_KEY.activeCount,
        p + GROUP_KEY.metas,
        p + QUEUE_KEY.metricsCompleted,
      ]),
      this.listWorkers(c, queueName).catch(() => null),
    ]);
    const r = asArray(reply);
    const meta = flatToHash(asArray(r[0]));
    const limiterTtl = asNumber(r[1], -2);
    const byStatus = groupsByStatus(r, 2);
    const groupsCount = byStatus.waiting + byStatus.limited + byStatus.maxed + byStatus.paused;
    const configured = asNumber(r[7]);
    const version = meta.version ?? null;
    // Same rule as queueStats.lua: any group key or a bullmq-pro version stamp.
    const isPro = groupsCount > 0 || configured > 0 || (version !== null && version.startsWith("bullmq-pro"));
    const max = toIntOrNull(meta.max);
    const duration = toIntOrNull(meta.duration);

    const { version: _v, paused: _p, concurrency: _c, max: _m, duration: _d, ...rest } = meta;
    const rawMeta: Record<string, string> = {};
    for (const [k, v] of Object.entries(rest)) if (v !== undefined) rawMeta[k] = v;

    const value: QueueSetup = {
      library: version,
      isPro,
      isPaused: meta.paused !== undefined,
      globalConcurrency: toIntOrNull(meta.concurrency),
      globalRateLimit: max !== null && duration !== null ? { max, durationMs: duration } : null,
      rateLimitedNow: limiterTtl >= 0 ? { ttlMs: limiterTtl } : null,
      workers,
      groups: isPro ? { count: groupsCount, byStatus, configured, active: asNumber(r[6]) } : null,
      batch: "unknown",
      metricsEnabled: asNumber(r[8]) === 1,
      maxLenEvents: toIntOrNull(meta["opts.maxLenEvents"]),
      rawMeta,
    };
    this.setupCache.set(queueName, { at: Date.now(), value });
    return value;
  }

  /**
   * Workers announce themselves with CLIENT SETNAME `${prefix}:${base64(queue)}`
   * (plus `:w:${workerName}` for named workers). Older versions used the raw
   * queue name, so both spellings are matched. In cluster mode the node with the
   * most matches wins (same heuristic as bullmq).
   */
  private async listWorkers(c: RedisClient, queueName: string): Promise<{ count: number; names: string[] }> {
    const candidates = [
      `${this.config.prefix}:${Buffer.from(queueName).toString("base64")}`,
      `${this.config.prefix}:${queueName}`,
    ];
    const matches = (name: string) => candidates.some((base) => name === base || name.startsWith(`${base}:w:`));
    const parse = (raw: string): string[] =>
      raw
        .split("\n")
        .map((line) => /(?:^|\s)name=(\S*)/.exec(line)?.[1] ?? "")
        .filter((name) => name !== "" && matches(name));

    let names: string[] = [];
    if (c instanceof Cluster) {
      const perNode = await Promise.all(c.nodes("master").map((n) => n.client("LIST").then((raw) => parse(String(raw)))));
      names = perNode.reduce((best, cur) => (cur.length > best.length ? cur : best), []);
    } else {
      names = parse(String(await c.client("LIST")));
    }
    const pretty = names.map((n) => {
      const idx = n.indexOf(":w:");
      return idx === -1 ? "worker" : n.slice(idx + 3);
    });
    return { count: names.length, names: pretty };
  }

  /**
   * One EVALSHA: pages across the four status zsets in Pro's own order (waiting,
   * limited, maxed, paused) and reads each group's list length, prioritized count,
   * active count and per-group overrides. See getGroups.lua and keys.ts.
   */
  async getGroups(queueName: string, opts: { start: number; end: number }): Promise<GroupsPage> {
    const c = await this.ensureConnected();
    const p = queueKeyPrefix(this.config.prefix, queueName);
    const reply = asArray(
      await callScript(c, "getGroups", [
        p + GROUP_KEY.groups,
        p + GROUP_KEY.limit,
        p + GROUP_KEY.max,
        p + GROUP_KEY.paused,
        p + GROUP_KEY.activeCount,
        p + GROUP_KEY.concurrencyLegacy,
        opts.start,
        opts.end,
        p,
      ]),
    );
    const groups = asArray(reply[2]).map((row): GroupSummary => {
      const r = asArray(row);
      const status = typeof r[1] === "string" && isGroupStatus(r[1]) ? r[1] : "waiting";
      const max = toIntOrNull(typeof r[6] === "string" ? r[6] : null);
      const duration = toIntOrNull(typeof r[7] === "string" ? r[7] : null);
      const score = Number(r[8]) || 0;
      return {
        id: String(r[0] ?? ""),
        status,
        waiting: asNumber(r[2]),
        prioritized: asNumber(r[3]),
        active: asNumber(r[4]),
        concurrency: toIntOrNull(typeof r[5] === "string" ? r[5] : null),
        rateLimit: max !== null && duration !== null ? { max, durationMs: duration } : null,
        limitedUntil: status === "limited" ? score : null,
        since: status === "maxed" || status === "paused" ? score : null,
      };
    });
    return { groups, total: asNumber(reply[0]), byStatus: groupsByStatus(asArray(reply[1]), 0) };
  }

  /**
   * A group's waiting jobs are its `groups:${id}` list followed by its `groups:${id}:p`
   * zset (prioritized), the order Pro serves them in; same script as getJobs.
   */
  async getGroupJobs(queueName: string, groupId: string, opts: { start: number; end: number }): Promise<JobsPage> {
    const p = queueKeyPrefix(this.config.prefix, queueName);
    return this.readPage(queueName, [p + GROUP_KEY.group(groupId), p + GROUP_KEY.groupPrioritized(groupId)], "list", "waiting", {
      ...opts,
      order: "desc",
    });
  }

  // ---------------------------------------------------------------------------
  // job schedulers (repeatable jobs)
  // ---------------------------------------------------------------------------

  /**
   * Schedulers live outside the 8 states, in the `repeat` zset (id -> next run)
   * plus one `repeat:${id}` hash each. getSchedulers.lua pages the zset and
   * HMGETs the page's hashes in a single EVALSHA, truncating data/opts in Lua.
   */
  async getSchedulers(queueName: string, opts: { start: number; end: number }): Promise<{ schedulers: JobScheduler[]; total: number }> {
    const c = await this.ensureConnected();
    const p = queueKeyPrefix(this.config.prefix, queueName);
    const reply = asArray(
      await callScript(c, "getSchedulers", [p + SCHEDULER_KEY.repeat, opts.start, opts.end, p, this.opts.previewBytes]),
    );
    const schedulers = asArray(reply[1]).map((row) => rowToScheduler(asArray(row)));
    return { schedulers, total: asNumber(reply[0]) };
  }

  /**
   * Official API: it removes the `repeat:${key}` hash, the zset member AND the
   * delayed job the scheduler had already queued. Reimplementing that here would
   * leave orphan delayed jobs behind.
   */
  async removeScheduler(queueName: string, key: string): Promise<{ removed: boolean }> {
    const queue = await this.getQueue(queueName);
    // removeJobScheduler-3.lua returns 0 on success / 1 when the id is unknown, and
    // queue.removeJobScheduler already negates it, so `true` means "removed".
    return { removed: (await queue.removeJobScheduler(key)) === true };
  }

  // ---------------------------------------------------------------------------
  // flows
  // ---------------------------------------------------------------------------

  async sampleFlowEdges(queueName: string, opts: { sample?: number } = {}): Promise<{ edges: FlowEdgeSample[]; sampled: number }> {
    const c = await this.ensureConnected();
    const sample = Math.max(1, opts.sample ?? 50);
    const keys = FLOW_SAMPLE_STATES.map((s) => stateKey(this.config.prefix, queueName, s));
    const types = FLOW_SAMPLE_STATES.map((s) => STATE_KEY[s].type);
    // numberOfKeys is dynamic for this script, so the key count goes first.
    const reply = asArray(
      await callScript(c, "sampleParents", [keys.length, ...keys, sample, queueKeyPrefix(this.config.prefix, queueName), ...types]),
    );
    const pairs = asArray(reply[1]);
    const edges: FlowEdgeSample[] = [];
    for (let i = 0; i + 1 < pairs.length; i += 2) {
      const queueKey = String(pairs[i] ?? "");
      edges.push({
        parentQueue: queueNameFromQueueKey(this.config.prefix, queueKey),
        childQueue: queueName,
        count: asNumber(pairs[i + 1]),
      });
    }
    edges.sort((a, b) => b.count - a.count);
    return { edges, sampled: asNumber(reply[0]) };
  }

  // ---------------------------------------------------------------------------
  // writes (official bullmq API; we never reimplement its Lua)
  // ---------------------------------------------------------------------------

  /**
   * bullmq needs a client it owns. We hand it connection options (or, for cluster,
   * a Cluster instance we own) and cache one Queue per name. `skipMetasUpdate` keeps
   * Queue construction from writing `meta.opts.maxLenEvents` on the customer's queue.
   */
  private async getQueue(queueName: string): Promise<Queue> {
    // Fail fast on a dead Redis instead of letting bullmq wait for a reconnect.
    await this.ensureConnected();
    let q = this.queues.get(queueName);
    if (q) return q;
    const { connection, ownedCluster } = createBullmqConnection(this.config, this.opts.connectTimeoutMs);
    if (ownedCluster) {
      // one shared Cluster client for every bullmq Queue of this inspector
      if (this.bullmqCluster) {
        ownedCluster.disconnect();
      } else {
        this.bullmqCluster = ownedCluster;
      }
    }
    q = new Queue(queueName, {
      connection: this.bullmqCluster ?? connection,
      prefix: this.config.prefix,
      skipMetasUpdate: true,
    });
    q.on("error", () => undefined);
    this.queues.set(queueName, q);
    return q;
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
    if (state !== "failed" && state !== "completed") {
      throw new Error(`cannot_retry_job_in_state_${state}`);
    }
    await job.retry(state);
  }

  async removeJob(queueName: string, jobId: string): Promise<void> {
    const job = await this.getBullJob(queueName, jobId);
    await job.remove();
  }

  async promoteJob(queueName: string, jobId: string): Promise<void> {
    const job = await this.getBullJob(queueName, jobId);
    await job.promote();
  }

  /**
   * Bulk action. Reuses EXACTLY the single-job actions above (hence the official
   * bullmq API and its atomic scripts), in windows of BULK_CONCURRENCY.
   *
   * Partial result is the rule: an id that was pruned, is in another state or fails
   * inside the script lands in `failed` with the reason, and the rest go through.
   * Aborting on the first error would hide the 47 that worked — and the operator
   * needs to know which 3 of the 50 were left behind. Only an unreachable Redis throws.
   */
  async bulkJobAction(queueName: string, action: BulkJobAction, jobIds: string[]): Promise<BulkJobActionResult> {
    const ok: string[] = [];
    const failed: BulkJobFailure[] = [];
    // Duplicate ids would cost a round trip to Redis just to say "job_not_found" on the second.
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

  /**
   * Operator "discard": move an active job to failed. `discard()` disables the
   * automatic retry, and the lock token "0" makes bullmq's moveToFinished skip the
   * worker-lock check (see includes/removeLock.lua), which is exactly what an
   * operator forcing a stuck job out needs.
   */
  async discardJob(queueName: string, jobId: string): Promise<void> {
    const job = await this.getBullJob(queueName, jobId);
    const state = await job.getState();
    if (state !== "active") {
      throw new Error(`cannot_discard_job_in_state_${state}`);
    }
    job.discard();
    try {
      await job.moveToFailed(new Error("Discarded from Bullpane"), "0");
    } catch (err) {
      throw new Error(`cannot_discard_active_job: ${errorMessage(err)}`);
    }
  }

  async pauseQueue(queueName: string): Promise<void> {
    const queue = await this.getQueue(queueName);
    await queue.pause();
  }

  async resumeQueue(queueName: string): Promise<void> {
    const queue = await this.getQueue(queueName);
    await queue.resume();
  }

  async cleanQueue(queueName: string, state: CleanableState, graceMs: number, limit: number): Promise<{ removed: number }> {
    const queue = await this.getQueue(queueName);
    const ids = await queue.clean(graceMs, limit, state);
    return { removed: ids.length };
  }

  async retryAll(queueName: string, state: "failed" | "completed"): Promise<void> {
    const queue = await this.getQueue(queueName);
    await queue.retryJobs({ state });
  }

  async drainQueue(queueName: string, includeDelayed: boolean): Promise<void> {
    const queue = await this.getQueue(queueName);
    await queue.drain(includeDelayed);
  }

  async obliterateQueue(queueName: string): Promise<void> {
    const queue = await this.getQueue(queueName);
    await queue.obliterate({ force: true });
    // the meta key is gone, so the cached discovery result is stale
    this.queues.delete(queueName);
    await queue.close().catch(() => undefined);
    this.invalidateDiscovery();
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function parseStats(reply: LuaReply, withMetrics: boolean, windowMinutes: number): QueueStats {
  const r = asArray(reply);
  const counts: QueueCounts = { ...EMPTY_COUNTS };
  STATE_ORDER.forEach((state, i) => {
    counts[state] = asNumber(r[i]);
  });
  // --- success rate --------------------------------------------------------
  // Two possible sources. BullMQ's metrics are per-minute counters written as each
  // job finishes, so they stay correct even with an aggressive removeOnComplete.
  // The zsets only see what still exists: with `removeOnComplete: { count: 50 }`,
  // 10,000 ok + 100 failures become 50/(50+100) = 33% when the real number is 99%.
  // We always prefer metrics.
  const metricsCompleted = metricPoints(r[11] ?? []);
  const metricsFailed = metricPoints(r[12] ?? []);
  const prunesCompleted = optsPrunesCompleted(typeof r[16] === "string" ? r[16] : null);

  // The cumulative counters exist as soon as the Worker turns `metrics` on; the
  // :data list only gains its first point when the minute rolls over. Reading the
  // hash is what makes the rate correct from the very first job.
  const totalCompleted = toIntOrNull(typeof r[17] === "string" ? r[17] : null);
  const totalFailed = toIntOrNull(typeof r[18] === "string" ? r[18] : null);
  const hasMetrics = totalCompleted !== null || totalFailed !== null;

  const sum = (xs: number[], n: number) => xs.slice(-n).reduce((a, b) => a + b, 0);

  let rates: QueueRates;
  if (hasMetrics) {
    // Inside the window when there are enough per-minute points; otherwise the
    // cumulative total since collection started (new queue, minute has not rolled over).
    const points = Math.min(windowMinutes, Math.max(metricsCompleted.length, metricsFailed.length));
    const useWindow = points > 0;
    const completed = useWindow ? sum(metricsCompleted, points) : (totalCompleted ?? 0);
    const failed = useWindow ? sum(metricsFailed, points) : (totalFailed ?? 0);
    const finished = completed + failed;
    rates = {
      windowMinutes: useWindow ? points : 0,
      completed,
      failed,
      successPct: finished === 0 ? null : Math.round((completed / finished) * 1000) / 10,
      source: "metrics",
      retentionSkewed: false,
    };
  } else {
    const completed = asNumber(r[13]);
    const failed = asNumber(r[14]);
    const finished = completed + failed;
    rates = {
      windowMinutes,
      completed,
      failed,
      successPct: finished === 0 ? null : Math.round((completed / finished) * 1000) / 10,
      source: "zset",
      // only skewed if the queue really does prune completed jobs AND there are
      // failures to unbalance the ratio; with no failures, 100% is still 100%.
      retentionSkewed: prunesCompleted && failed > 0,
    };
  }
  const stats: QueueStats = {
    counts,
    isPaused: asNumber(r[8]) === 1,
    isPro: asNumber(r[9]) === 1,
    groupsCount: asNumber(r[10]),
    rates,
    library: typeof r[15] === "string" && r[15] !== "" ? r[15] : null,
    schedulersCount: asNumber(r[19]),
    stalledCount: asNumber(r[20]),
  };
  if (withMetrics) {
    stats.metrics = { completed: metricsCompleted, failed: metricsFailed };
  }
  return stats;
}

const JOB_STATE_SET = new Set<string>(STATE_ORDER);
function isJobState(s: string): s is JobState {
  return JOB_STATE_SET.has(s);
}

const GROUP_STATUS_SET = new Set<string>(GROUP_STATUSES);
function isGroupStatus(s: string): s is GroupStatus {
  return GROUP_STATUS_SET.has(s);
}

/** Four consecutive ZCARDs in GROUP_STATUSES order, starting at `from`. */
function groupsByStatus(r: LuaReply[], from: number): Record<GroupStatus, number> {
  return {
    waiting: asNumber(r[from]),
    limited: asNumber(r[from + 1]),
    maxed: asNumber(r[from + 2]),
    paused: asNumber(r[from + 3]),
  };
}

function stripUndefined<T extends object>(o: T): Partial<T> {
  const out: Partial<T> = {};
  for (const [k, v] of Object.entries(o)) {
    if (v !== undefined) (out as Record<string, unknown>)[k] = v;
  }
  return out;
}

/**
 * `removeOnComplete` lives in each job's opts. If the queue prunes completed jobs,
 * the ratio computed on top of the zsets is not trustworthy: failed jobs are usually
 * retained longer than completed ones.
 *
 * `true` only when there is actual pruning: `removeOnComplete: true` (deletes right
 * away), `{ count: N }` or `{ age: N }`. `false` (the default) keeps everything and
 * is trustworthy.
 */
export function optsPrunesCompleted(optsJson: string | null): boolean {
  if (!optsJson) return false;
  try {
    const opts = JSON.parse(optsJson) as { removeOnComplete?: unknown };
    const r = opts.removeOnComplete;
    if (r === undefined || r === null || r === false) return false;
    if (r === true) return true;
    if (typeof r === "number") return true;
    if (typeof r === "object") {
      const o = r as { count?: unknown; age?: unknown };
      return typeof o.count === "number" || typeof o.age === "number";
    }
    return false;
  } catch {
    return false;
  }
}
