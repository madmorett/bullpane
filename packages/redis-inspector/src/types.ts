/**
 * Public contract of the redis inspector. The server codes against THIS file.
 * Implementation lives in inspector.ts / pool.ts / lua/*.lua.
 *
 * Performance rules (non-negotiable):
 *  - Never call KEYS. Discovery uses SCAN with MATCH `${prefix}:*:meta`, bounded per pass.
 *  - One round trip per read operation: counts, job pages and job detail are Lua scripts
 *    loaded once with `defineCommand` (EVALSHA). Multi-queue reads are pipelined.
 *  - List views truncate `data`/`returnvalue` inside Lua (previewBytes) so we never
 *    ship megabytes of payload for a table row.
 *  - Search is a bounded, resumable scan (maxScanPerCall) inside Lua using plain
 *    string.find (no patterns). Never scans a whole state in one call.
 *  - Reads never mutate. Writes go through the official `bullmq` Queue/Job API so we
 *    inherit its exact atomic Lua semantics (retry, promote, remove, clean, drain, ...).
 *  - All keys of one queue share the same hash tag in cluster mode, so every script
 *    touches keys of exactly one queue.
 */
import type {
  BulkJobAction,
  BulkJobActionResult,
  DiscoveryStatus,
  GroupsPage,
  JobScheduler,
  JobTreeNode,
  QueueRates,
  QueueSetup,
  JobDetail,
  JobsPage,
  JobSearchResult,
  JobState,
  QueueCounts,
  QueueMetrics,
  RedisServerInfo,
} from "@bullpane/shared";

export interface InspectorConnectionConfig {
  /** stable id (the connection row id) used to key the pool */
  id: string;
  url: string;
  /** BullMQ prefix, default "bull" */
  prefix?: string;
  cluster?: boolean;
  /** optional glob for discovery, e.g. "payments-*" */
  queueFilter?: string | null;
}

export interface InspectorOptions {
  /** ms to cache the discovered queue list. default 30_000 */
  discoveryTtlMs?: number;
  /** bytes of data/returnvalue kept in list previews. default 2048 */
  previewBytes?: number;
  /** max jobs one search call inspects before returning a cursor. default 1000 */
  maxScanPerCall?: number;
  /** ms connect timeout. default 5000 */
  connectTimeoutMs?: number;
  /**
   * max SCAN iterations per discovery pass. default 2000 (× COUNT 1000 = 2M keys).
   * A pass also stops at discoveryScanBudgetMs; the cursor is kept, so the next
   * pass continues where this one stopped and the full keyspace is eventually
   * covered no matter how big it is.
   */
  maxScanIterations?: number;
  /** ms of SCAN work one discovery pass may spend. default 1500 */
  discoveryScanBudgetMs?: number;
  /** once a full SCAN cycle completed, how often to run another. default 300_000 (5 min) */
  fullScanIntervalMs?: number;
  /**
   * `data` / `returnvalue` longer than this are not copied out of Redis for LIST
   * views (HSTRLEN first); the row carries the size instead. default 32 KiB, so a
   * 200-job page never moves more than ~6 MB through Lua.
   */
  listFieldCapBytes?: number;
  /** `data` longer than this is not searched (id / name / error still are). default 256 KiB */
  searchFieldCapBytes?: number;
  /** payload bytes one search call may copy before handing back a cursor. default 8 MiB */
  searchByteBudget?: number;
}

export interface QueueStats {
  counts: QueueCounts;
  isPaused: boolean;
  /** true when the Pro `groups` zset exists or meta.version starts with "bullmq-pro" */
  isPro: boolean;
  groupsCount: number;
  /** completed / failed inside the trailing window (ZCOUNT, O(log N)) */
  rates: QueueRates;
  /** meta.version, e.g. "bullmq:5.81.4" */
  library: string | null;
  /** ZCARD of the `repeat` zset: how many job schedulers this queue has */
  schedulersCount: number;
  /**
   * SCARD of `${prefix}:${queue}:stalled`. A SCARD is O(1), so it fits inside the
   * queueStats budget (one more command in the SAME EVALSHA, zero extra round trips).
   *
   * `stalled` is NOT a BullMQ state: it is an auxiliary SET that only exists while
   * something is stalling, and `getState()` on a stalled job returns `active`. That
   * is why this number lives outside `counts`.
   */
  stalledCount: number;
  metrics?: QueueMetrics;
}

export interface WindowCounts {
  /** finished jobs (completed zset) whose score >= since */
  completed: number;
  /** failed jobs whose score >= since */
  failed: number;
}

/**
 * BullMQ's own cumulative counters, the only prune-proof source of "how many
 * jobs finished".
 *
 * When a Worker is created with `metrics: { maxDataPoints }` BullMQ keeps a hash
 * `${prefix}:${queue}:metrics:completed` (and `:failed`) whose `count` field is
 * incremented as each job finishes and is NEVER decremented — `removeOnComplete`
 * cannot touch it. The sibling list `metrics:*:data` only gains a point when the
 * minute rolls over, so for the first 60 s the list is empty while `count` is
 * already right; that is why alerting reads the hash, not the list.
 *
 * `null` means the hash does not exist: this queue collects no metrics, and
 * therefore its failure rate cannot be measured honestly at all.
 */
export interface MetricsCounters {
  completed: number | null;
  failed: number | null;
  /** unix ms when the read was taken (the clock the delta is computed against) */
  collectedAt: number;
}

/**
 * The result of one flow-tree walk, before a route stamps the connection id on it.
 * `truncated` means the node budget stopped the walk, so the tree drawn is partial.
 */
export interface JobTreeWalk {
  rootKey: string;
  focusKey: string;
  nodes: JobTreeNode[];
  truncated: boolean;
  visited: number;
  climbedLevels: number;
}

export interface FlowEdgeSample {
  /** queue name of the parent (the one waiting for children) */
  parentQueue: string;
  /** queue name of the child (the sampled job's queue) */
  childQueue: string;
  /** number of sampled jobs pointing at parentQueue */
  count: number;
}

export interface PingResult {
  ok: boolean;
  latencyMs: number;
  redisVersion: string | null;
  error: string | null;
}

export type CleanableState =
  | "completed"
  | "failed"
  | "delayed"
  | "wait"
  | "active"
  | "paused"
  | "prioritized";

export interface Inspector {
  readonly config: Required<Pick<InspectorConnectionConfig, "id" | "url" | "prefix" | "cluster">> &
    InspectorConnectionConfig;

  // --- connection ---------------------------------------------------------
  ping(): Promise<PingResult>;
  serverInfo(): Promise<RedisServerInfo>;
  close(): Promise<void>;

  // --- discovery ----------------------------------------------------------
  /** Cached (discoveryTtlMs). Sorted queue names. */
  discoverQueues(opts?: { force?: boolean }): Promise<string[]>;
  /** how far the SCAN-based discovery got; see DiscoveryStatus */
  discoveryStatus(): Promise<DiscoveryStatus>;

  // --- reads (Lua, one round trip / pipelined) ----------------------------
  /** Counts for many queues in one pipeline of EVALSHA calls. `rateWindowMinutes` defaults to 60. */
  getQueueStats(
    queueNames: string[],
    opts?: { withMetrics?: boolean; rateWindowMinutes?: number },
  ): Promise<Record<string, QueueStats>>;
  /** meta hash + limiter TTL + Pro group settings (one script) + workers via CLIENT LIST. Cached 10 s. */
  getQueueSetup(queueName: string): Promise<QueueSetup>;
  /**
   * ZCOUNT on completed/failed inside a trailing window. Honest only for queues
   * that keep their finished jobs — with `removeOnComplete` the ratio lies, so
   * alerting uses `getMetricsCounters` instead. Kept for panel-side reads.
   */
  getWindowCounts(queueName: string, since: number): Promise<WindowCounts>;
  /**
   * The cumulative `count` of `metrics:completed` / `metrics:failed` in ONE
   * round trip (two HGETs in a pipeline, both keys of the same queue so it is
   * cluster safe). `null` per side when the hash is absent. Diffing this between
   * two reads is what error alerts measure.
   */
  getMetricsCounters(queueName: string): Promise<MetricsCounters>;
  getJobs(
    queueName: string,
    state: JobState,
    opts: { start: number; end: number; order: "asc" | "desc" },
  ): Promise<JobsPage>;
  searchJobs(
    queueName: string,
    state: JobState,
    query: string,
    opts: { cursor?: string | null; limit: number },
  ): Promise<JobSearchResult>;
  getJob(queueName: string, jobId: string): Promise<JobDetail | null>;
  getJobLogs(queueName: string, jobId: string, opts: { start: number; end: number }): Promise<{ logs: string[]; count: number }>;
  getMetrics(queueName: string, points: number): Promise<QueueMetrics>;

  // --- BullMQ Pro groups (read) ------------------------------------------
  getGroups(queueName: string, opts: { start: number; end: number }): Promise<GroupsPage>;
  getGroupJobs(queueName: string, groupId: string, opts: { start: number; end: number }): Promise<JobsPage>;

  // --- job schedulers (repeatable jobs) -----------------------------------
  /**
   * Page the `repeat` zset (ordered by next run) plus one HMGET per row, all in
   * ONE script. Schedulers are invisible in the 8 job states, so this is the only
   * read that shows them.
   */
  getSchedulers(queueName: string, opts: { start: number; end: number }): Promise<{ schedulers: JobScheduler[]; total: number }>;
  /** Remove a job scheduler and the delayed job it has queued (official bullmq API). */
  removeScheduler(queueName: string, key: string): Promise<{ removed: boolean }>;

  // --- flows --------------------------------------------------------------
  /** Sample the newest N jobs of several states and aggregate their parent queue keys. */
  sampleFlowEdges(queueName: string, opts?: { sample?: number }): Promise<{ edges: FlowEdgeSample[]; sampled: number }>;

  /**
   * The parent/child tree of ONE flow instance, breadth-first from the root and
   * bounded by `maxNodes`. Each level is pipelined per queue, so the read stays
   * single-slot per call on a cluster. Returns null when the job does not exist.
   */
  getJobTree(
    queueName: string,
    jobId: string,
    opts?: { maxNodes?: number; fromRoot?: boolean },
  ): Promise<JobTreeWalk | null>;

  // --- writes (official bullmq API) --------------------------------------
  addJob(queueName: string, name: string, data: unknown, opts?: Record<string, unknown>): Promise<{ id: string }>;
  retryJob(queueName: string, jobId: string): Promise<void>;
  removeJob(queueName: string, jobId: string): Promise<void>;
  promoteJob(queueName: string, jobId: string): Promise<void>;
  /**
   * The same single-job action (retry / remove / promote) applied to many ids, ALWAYS
   * through the official bullmq API (`job.retry()` / `job.remove()` / `job.promote()`),
   * never a hand-rolled DEL: BullMQ's atomic scripts take care of indexes, flow
   * dependencies and locks.
   *
   * Two guarantees the caller can rely on:
   *  - PARTIAL RESULT: an id that does not exist or is in an incompatible state
   *    becomes an entry in `failed` with the reason; the rest go through. It never
   *    throws because of a bad id (only when Redis is unreachable).
   *  - BOUNDED CONCURRENCY (`BULK_CONCURRENCY`): the actions run in small windows,
   *    not in a `Promise.all` of 500, so Redis is not flooded.
   */
  bulkJobAction(queueName: string, action: BulkJobAction, jobIds: string[]): Promise<BulkJobActionResult>;
  /** Move an active/stalled job back to failed with a reason (operator "discard") */
  discardJob(queueName: string, jobId: string): Promise<void>;
  pauseQueue(queueName: string): Promise<void>;
  resumeQueue(queueName: string): Promise<void>;
  cleanQueue(queueName: string, state: CleanableState, graceMs: number, limit: number): Promise<{ removed: number }>;
  /** retry every job in `failed` (or `completed`) */
  retryAll(queueName: string, state: "failed" | "completed"): Promise<void>;
  drainQueue(queueName: string, includeDelayed: boolean): Promise<void>;
  obliterateQueue(queueName: string): Promise<void>;
}

export interface InspectorPool {
  /** Returns the cached inspector for this config, creating it if needed. Reconnects if url/prefix changed. */
  get(config: InspectorConnectionConfig): Inspector;
  /** Close & drop an inspector (connection deleted or edited). */
  evict(id: string): Promise<void>;
  closeAll(): Promise<void>;
}
