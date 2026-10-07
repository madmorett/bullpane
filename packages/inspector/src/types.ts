/**
 * The contract every queue backend implements. The server codes against THIS
 * file and never against a concrete inspector; `@bullpane/redis-inspector` and
 * `@bullpane/pg-inspector` are the two implementations.
 *
 * Performance rules (non-negotiable), stated per backend in ARCHITECTURE.md:
 *  - One round trip per read. Redis: one EVALSHA (pipelined across queues).
 *    Postgres: one SQL statement (CTEs, never N queries in a loop).
 *  - Nothing unbounded: Redis never calls KEYS and every SCAN has a budget;
 *    Postgres pins `state` in every job query so the partial indexes are used.
 *  - List views truncate `data`/`returnvalue` on the server side (Lua or SQL),
 *    so we never ship megabytes of payload for a table row.
 *  - Reads never mutate. Writes go through the official `bullmq` Queue/Job API
 *    so we inherit its exact atomic semantics (retry, promote, remove, clean, ...).
 *  - Redis cluster: all keys of one queue share the same hash tag, so every
 *    script touches keys of exactly one queue.
 */
import type {
  BulkJobAction,
  BulkJobActionResult,
  DelayedGroupsPage,
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
  PromoteJobResult,
  PromoteMatchingResult,
  CountMatchingResult,
  SchedulerPromoteMode,
  QueueCounts,
  QueueMetrics,
  ConnectionKind,
  ServerInfo,
} from "@bullpane/shared";

export interface InspectorConnectionConfig {
  /** stable id (the connection row id) used to key the pool */
  id: string;
  /** which backend the queues live in. default "redis" */
  kind?: ConnectionKind;
  url: string;
  /**
   * The namespace of the queues: the Redis key prefix (default "bull") or the
   * Postgres schema (default "bullmq"). See DEFAULT_NAMESPACE.
   */
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
  /**
   * max jobs one group-filtered search call inspects. A job outside the group costs
   * one HMGET of its group fields and opts, never its payload, so a call can cover
   * more of the state. default 10000
   */
  groupScanPerCall?: number;
  /**
   * max jobs one "groups with delayed jobs" call inspects. Each job is one HMGET and
   * each distinct group four ZSCOREs, so the worst case (every job its own group) is
   * ~2.6 ms of Redis per 1000 jobs, measured. default 2500 (~6.5 ms)
   */
  delayedGroupsScanPerCall?: number;
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
  /**
   * BullMQ Pro's module, from `loadBullmqPro` (Redis only). When present, writes on
   * Pro queues go through QueuePro / JobPro and the group actions are available;
   * when absent, the writes core bullmq would get wrong on a group are refused.
   * Typed loosely here so this contract does not depend on redis-inspector.
   */
  bullmqPro?: unknown;
}

export interface QueueStats {
  counts: QueueCounts;
  isPaused: boolean;
  /** true when the Pro `groups` zset exists or meta.version starts with "bullmq-pro" */
  isPro: boolean;
  groupsCount: number;
  /**
   * BullMQ Pro: jobs waiting in groups, which Pro keeps in each group's list and not
   * in `wait` (so counts.waiting misses them). Only filled when getQueueStats is
   * asked with `groupWaitingCap`; `groups` is how many were summed, fewer than
   * groupsCount means the sum stopped at the cap.
   */
  groupWaiting?: { jobs: number; groups: number };
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
/** What one queue needs measured this tick. Windows are in minutes. */
export interface WindowMetricsRequest {
  queue: string;
  rateWindows: number[];
  durationWindows: number[];
}

export interface WindowRate {
  windowMinutes: number;
  completed: number;
  failed: number;
  /**
   * Minutes of the window BullMQ's metrics actually cover. Lower than
   * `windowMinutes` when the queue started collecting recently or
   * `maxDataPoints` is shorter than the window: the counts are then a floor.
   */
  coveredMinutes: number;
}

export interface WindowDuration {
  windowMinutes: number;
  /** completed jobs read (newest first, capped by the caller) */
  sampled: number;
  /** null when nothing was sampled */
  p50Ms: number | null;
  p95Ms: number | null;
}

/**
 * Finished-job counts over trailing windows from BullMQ's per-minute metrics
 * lists (exact to the minute, immune to removeOnComplete), plus a bounded
 * processing-time sample from the completed zset. See lua/windowMetrics.lua.
 */
export interface WindowMetrics {
  /** false when the Worker was created without `metrics`: rates cannot be measured */
  hasMetrics: boolean;
  rates: WindowRate[];
  durations: WindowDuration[];
  /** unix ms of the read */
  collectedAt: number;
}

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

/**
 * promoteMatching's optional "spread" mode: lay the matching jobs out evenly from
 * `from` to `until` (unix ms), soonest first, never later than they already were.
 * `total` jobs in all, `offset` of them handled by earlier calls.
 */
export interface SpreadPlan {
  from: number;
  until: number;
  total: number;
  offset: number;
}

export interface Inspector {
  readonly config: Required<Pick<InspectorConnectionConfig, "id" | "kind" | "url" | "prefix" | "cluster">> &
    InspectorConnectionConfig;

  // --- connection ---------------------------------------------------------
  ping(): Promise<PingResult>;
  serverInfo(): Promise<ServerInfo>;
  close(): Promise<void>;

  // --- discovery ----------------------------------------------------------
  /** Cached (discoveryTtlMs). Sorted queue names. */
  discoverQueues(opts?: { force?: boolean }): Promise<string[]>;
  /** how far the SCAN-based discovery got; see DiscoveryStatus */
  discoveryStatus(): Promise<DiscoveryStatus>;

  // --- reads (Lua, one round trip / pipelined) ----------------------------
  /**
   * Counts for many queues in one pipeline of EVALSHA calls. `rateWindowMinutes` defaults to 60.
   * `groupWaitingCap` (BullMQ Pro) sums the waiting jobs of up to that many groups into
   * `groupWaiting`; meant for the single-queue page, not for lists of queues.
   */
  getQueueStats(
    queueNames: string[],
    opts?: { withMetrics?: boolean; rateWindowMinutes?: number; groupWaitingCap?: number },
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
  /**
   * Windowed rates + durations for many queues of this connection: one EVALSHA
   * per queue, all in ONE pipeline (parallel single calls on a cluster). A
   * queue whose script errored is left out of the result.
   */
  getWindowMetrics(requests: WindowMetricsRequest[], opts?: { durationSample?: number; now?: number }): Promise<Record<string, WindowMetrics>>;
  getJobs(
    queueName: string,
    state: JobState,
    opts: { start: number; end: number; order: "asc" | "desc" },
  ): Promise<JobsPage>;
  /**
   * Bounded, resumable substring search over one state. `groupId` (BullMQ Pro)
   * keeps only that group's jobs, checked before any payload is read; with it an
   * empty `query` matches every job of the group.
   */
  searchJobs(
    queueName: string,
    state: JobState,
    query: string,
    opts: { cursor?: string | null; limit: number; groupId?: string },
  ): Promise<JobSearchResult>;
  getJob(queueName: string, jobId: string): Promise<JobDetail | null>;
  getJobLogs(queueName: string, jobId: string, opts: { start: number; end: number }): Promise<{ logs: string[]; count: number }>;
  getMetrics(queueName: string, points: number): Promise<QueueMetrics>;

  // --- BullMQ Pro groups (read) ------------------------------------------
  getGroups(queueName: string, opts: { start: number; end: number }): Promise<GroupsPage>;
  getGroupJobs(queueName: string, groupId: string, opts: { start: number; end: number }): Promise<JobsPage>;
  /** Groups that have delayed jobs, from one bounded slice of `delayed` (getDelayedGroups.lua). */
  getDelayedGroups(queueName: string, opts: { cursor?: string | null }): Promise<DelayedGroupsPage>;

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
  /**
   * Promotes a delayed job. For one a job scheduler produced, `scheduler` says whether to
   * run a one-off copy (default) or promote it and skip the next run (SchedulerPromoteMode).
   */
  promoteJob(queueName: string, jobId: string, scheduler?: SchedulerPromoteMode): Promise<PromoteJobResult>;
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
  /**
   * Promote the delayed jobs that match `query` and / or BullMQ Pro `groupId`, beyond
   * the 500-id bulk ceiling: scans the delayed state in bounded slices (the search
   * script), stops after `limit` matches, then promotes them with `promoteJob` (so
   * Pro-aware, BULK_CONCURRENCY at a time). `nextCursor` continues the scan.
   */
  promoteMatching(
    queueName: string,
    match: { query?: string; groupId?: string },
    opts: { cursor?: string | null; limit: number; spread?: SpreadPlan },
  ): Promise<PromoteMatchingResult>;
  /** How many delayed jobs promoteMatching would act on (bounded slices, nothing written). */
  countMatching(queueName: string, match: { query?: string; groupId?: string }, opts: { cursor?: string | null }): Promise<CountMatchingResult>;
  /** Move an active/stalled job back to failed with a reason (operator "discard") */
  discardJob(queueName: string, jobId: string): Promise<void>;
  pauseQueue(queueName: string): Promise<void>;
  resumeQueue(queueName: string): Promise<void>;
  cleanQueue(queueName: string, state: CleanableState, graceMs: number, limit: number): Promise<{ removed: number }>;
  /** retry every job in `failed` (or `completed`) */
  retryAll(queueName: string, state: "failed" | "completed"): Promise<void>;
  drainQueue(queueName: string, includeDelayed: boolean): Promise<void>;
  obliterateQueue(queueName: string): Promise<void>;

  // --- BullMQ Pro groups (write) -------------------------------------------
  /**
   * true when BullMQ Pro's API is loaded (see InspectorOptions.bullmqPro). The group
   * actions below throw `bullmq_pro_api_required` without it: they only exist in Pro.
   */
  readonly bullmqProApi: boolean;
  /** QueuePro.pauseGroup: jobs keep arriving, none of the group's are processed */
  pauseGroup(queueName: string, groupId: string): Promise<void>;
  resumeGroup(queueName: string, groupId: string): Promise<void>;
  /** QueuePro.deleteGroup: removes the group's waiting and prioritized jobs, then the group */
  drainGroup(queueName: string, groupId: string): Promise<void>;
}

export interface InspectorPool {
  /** Returns the cached inspector for this config, creating it if needed. Reconnects if url/prefix changed. */
  get(config: InspectorConnectionConfig): Inspector;
  /** Close & drop an inspector (connection deleted or edited). */
  evict(id: string): Promise<void>;
  closeAll(): Promise<void>;
}
