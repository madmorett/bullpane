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
  type GroupSummary,
  type JobDetail,
  type JobSearchResult,
  type JobState,
  type JobsPage,
  type JobSummary,
  type QueueCounts,
  type QueueMetrics,
  type RedisServerInfo,
  type QueueRates,
  type QueueSetup,
} from "@bullmq-visualizer/shared";
import { createBullmqConnection, createReadClient } from "./connection.js";
import {
  GROUP_KEY,
  JOB_KEY,
  JOB_SUMMARY_FIELDS,
  QUEUE_KEY,
  STATE_ORDER,
  allStateKeys,
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
  type LuaReply,
} from "./parse.js";
import { callScript, defineScripts, pipelineScript, type RedisClient } from "./scripts.js";
import type {
  CleanableState,
  FlowEdgeSample,
  Inspector,
  InspectorConnectionConfig,
  InspectorOptions,
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
  maxScanIterations: 200,
};

/** SCAN COUNT hint: big enough to finish quickly, small enough not to stall Redis. */
const SCAN_COUNT = 500;
/** Metric points returned by getQueueStats when withMetrics is set (one per minute). */
const STATS_METRIC_POINTS = 60;
/** Trailing window for QueueRates (success / failure %). */
const DEFAULT_RATE_WINDOW_MINUTES = 60;
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
   * SCAN (never KEYS) for `${prefix}:*:meta`, one meta hash per queue. Bounded by
   * maxScanIterations * COUNT keys per pass and cached for discoveryTtlMs; concurrent
   * callers share one in-flight pass.
   */
  async discoverQueues(opts: { force?: boolean } = {}): Promise<string[]> {
    const now = Date.now();
    if (!opts.force && this.discovered && now - this.discovered.at < this.opts.discoveryTtlMs) {
      return this.discovered.names;
    }
    if (!this.discovering) {
      this.discovering = this.scanQueues()
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

  private async scanQueues(): Promise<string[]> {
    const c = await this.ensureConnected();
    // In cluster mode SCAN is per node; every master owns a disjoint slice of the keyspace.
    const nodes: Redis[] = c instanceof Cluster ? c.nodes("master") : [c];
    const pattern = metaScanPattern(this.config.prefix);
    const found = new Set<string>();
    let budget = this.opts.maxScanIterations;
    for (const node of nodes) {
      let cursor = "0";
      do {
        const [next, keys] = await node.scan(cursor, "MATCH", pattern, "COUNT", SCAN_COUNT);
        cursor = next;
        budget -= 1;
        for (const key of keys) {
          const name = parseQueueNameFromMetaKey(this.config.prefix, key);
          if (name && (!this.filter || this.filter.test(name))) found.add(name);
        }
      } while (cursor !== "0" && budget > 0);
      if (budget <= 0) break;
    }
    return [...found].sort((a, b) => a.localeCompare(b));
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
          callScript(c, "queueStats", [...this.statsKeys(q), withMetrics, STATS_METRIC_POINTS, since]).catch(() => null),
        ),
      );
    } else {
      const pipeline = c.pipeline();
      for (const q of queueNames) {
        pipelineScript(pipeline, "queueStats", [...this.statsKeys(q), withMetrics, STATS_METRIC_POINTS, since]);
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

  async getJobs(
    queueName: string,
    state: JobState,
    opts: { start: number; end: number; order: "asc" | "desc" },
  ): Promise<JobsPage> {
    const key = stateKey(this.config.prefix, queueName, state);
    return this.readPage(queueName, key, STATE_KEY[state].type, state, opts);
  }

  private async readPage(
    queueName: string,
    key: string,
    type: "list" | "zset",
    state: JobState | "unknown",
    opts: { start: number; end: number; order: "asc" | "desc" },
  ): Promise<JobsPage> {
    const c = await this.ensureConnected();
    const reply = asArray(
      await callScript(c, "getJobs", [
        key,
        type,
        opts.start,
        opts.end,
        opts.order,
        queueKeyPrefix(this.config.prefix, queueName),
        this.opts.previewBytes,
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
    const { id, hash, truncated } = rowToHash(asArray(row));
    return hashToSummary(this.config.prefix, id, hash, state, truncated);
  }

  /**
   * Bounded, resumable search: at most maxScanPerCall hashes per call, plain
   * substring match done in Lua. The cursor is the index of the next job (newest = 0).
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
        ...JOB_SUMMARY_FIELDS,
      ]),
    );
    const next = asNumber(reply[1], -1);
    return {
      jobs: asArray(reply[0]).map((row) => this.rowToSummary(row, state)),
      nextCursor: next < 0 ? null : String(next),
      scanned: asNumber(reply[2]),
      total: asNumber(reply[3]),
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
        p + GROUP_KEY.active,
        p + GROUP_KEY.paused,
        p + GROUP_KEY.max,
        p + GROUP_KEY.limit,
        p + QUEUE_KEY.metricsCompleted,
      ]),
      this.listWorkers(c, queueName).catch(() => null),
    ]);
    const r = asArray(reply);
    const meta = flatToHash(asArray(r[0]));
    const limiterTtl = asNumber(r[1], -2);
    const hasGroups = asNumber(r[2]) === 1;
    const version = meta.version ?? null;
    const isPro = hasGroups || (version !== null && version.startsWith("bullmq-pro"));
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
      groups: isPro
        ? {
            count: asNumber(r[3]),
            activeGroups: asNumber(r[4]),
            pausedGroups: asNumber(r[5]),
            concurrencyLimited: asNumber(r[6]) === 1,
            rateLimited: asNumber(r[7]) === 1,
          }
        : null,
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

  async getGroups(queueName: string, opts: { start: number; end: number }): Promise<{ groups: GroupSummary[]; total: number }> {
    const c = await this.ensureConnected();
    const p = queueKeyPrefix(this.config.prefix, queueName);
    const reply = asArray(
      await callScript(c, "getGroups", [
        p + GROUP_KEY.groups,
        p + GROUP_KEY.active,
        p + GROUP_KEY.paused,
        p + GROUP_KEY.max,
        p + GROUP_KEY.limit,
        opts.start,
        opts.end,
        p,
      ]),
    );
    const groups = asArray(reply[1]).map((row): GroupSummary => {
      const r = asArray(row);
      const status = typeof r[3] === "string" ? r[3] : "unknown";
      return {
        id: String(r[0] ?? ""),
        score: Number(r[1]) || 0,
        waiting: asNumber(r[2]),
        status: isGroupStatus(status) ? status : "unknown",
      };
    });
    return { groups, total: asNumber(reply[0]) };
  }

  /** A group's waiting jobs live in the `groups:${id}` list; same script as getJobs. */
  async getGroupJobs(queueName: string, groupId: string, opts: { start: number; end: number }): Promise<JobsPage> {
    const key = queueKeyPrefix(this.config.prefix, queueName) + GROUP_KEY.group(groupId);
    return this.readPage(queueName, key, "list", "waiting", { ...opts, order: "desc" });
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
      await job.moveToFailed(new Error("Discarded from BullMQ Visualizer"), "0");
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
  const completed = asNumber(r[13]);
  const failed = asNumber(r[14]);
  const finished = completed + failed;
  const rates: QueueRates = {
    windowMinutes,
    completed,
    failed,
    successPct: finished === 0 ? null : Math.round((completed / finished) * 1000) / 10,
  };
  const stats: QueueStats = {
    counts,
    isPaused: asNumber(r[8]) === 1,
    isPro: asNumber(r[9]) === 1,
    groupsCount: asNumber(r[10]),
    rates,
    library: typeof r[15] === "string" && r[15] !== "" ? r[15] : null,
  };
  if (withMetrics) {
    stats.metrics = { completed: metricPoints(r[11] ?? []), failed: metricPoints(r[12] ?? []) };
  }
  return stats;
}

const JOB_STATE_SET = new Set<string>(STATE_ORDER);
function isJobState(s: string): s is JobState {
  return JOB_STATE_SET.has(s);
}

const GROUP_STATUSES = new Set<string>(["active", "waiting", "paused", "rate-limited", "maxed", "unknown"]);
function isGroupStatus(s: string): s is GroupSummary["status"] {
  return GROUP_STATUSES.has(s);
}

function stripUndefined<T extends object>(o: T): Partial<T> {
  const out: Partial<T> = {};
  for (const [k, v] of Object.entries(o)) {
    if (v !== undefined) (out as Record<string, unknown>)[k] = v;
  }
  return out;
}
