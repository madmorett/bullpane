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
  GroupSummary,
  QueueRates,
  QueueSetup,
  JobDetail,
  JobsPage,
  JobSearchResult,
  JobState,
  QueueCounts,
  QueueMetrics,
  RedisServerInfo,
} from "@bullmq-visualizer/shared";

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
  /** max SCAN iterations per discovery pass. default 200 (200 * COUNT 500 keys) */
  maxScanIterations?: number;
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
  metrics?: QueueMetrics;
}

export interface WindowCounts {
  /** finished jobs (completed zset) whose score >= since */
  completed: number;
  /** failed jobs whose score >= since */
  failed: number;
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

  // --- reads (Lua, one round trip / pipelined) ----------------------------
  /** Counts for many queues in one pipeline of EVALSHA calls. `rateWindowMinutes` defaults to 60. */
  getQueueStats(
    queueNames: string[],
    opts?: { withMetrics?: boolean; rateWindowMinutes?: number },
  ): Promise<Record<string, QueueStats>>;
  /** meta hash + limiter TTL + Pro group settings (one script) + workers via CLIENT LIST. Cached 10 s. */
  getQueueSetup(queueName: string): Promise<QueueSetup>;
  /** ZCOUNT on completed/failed for alerting. `since` is unix ms. */
  getWindowCounts(queueName: string, since: number): Promise<WindowCounts>;
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
  getGroups(queueName: string, opts: { start: number; end: number }): Promise<{ groups: GroupSummary[]; total: number }>;
  getGroupJobs(queueName: string, groupId: string, opts: { start: number; end: number }): Promise<JobsPage>;

  // --- flows --------------------------------------------------------------
  /** Sample the newest N jobs of several states and aggregate their parent queue keys. */
  sampleFlowEdges(queueName: string, opts?: { sample?: number }): Promise<{ edges: FlowEdgeSample[]; sampled: number }>;

  // --- writes (official bullmq API) --------------------------------------
  addJob(queueName: string, name: string, data: unknown, opts?: Record<string, unknown>): Promise<{ id: string }>;
  retryJob(queueName: string, jobId: string): Promise<void>;
  removeJob(queueName: string, jobId: string): Promise<void>;
  promoteJob(queueName: string, jobId: string): Promise<void>;
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
