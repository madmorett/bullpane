/**
 * @bullmq-visualizer/shared
 *
 * Single source of truth for the types and validation schemas shared by
 * the server, the web UI, the redis inspector and the simulator.
 *
 * Rule: if the server returns it or the UI sends it, the shape lives here.
 */
import { z } from "zod";

// ---------------------------------------------------------------------------
// Edition / licensing
// ---------------------------------------------------------------------------

export type Tier = "free" | "pro";

export const PRO_FEATURES = ["alerts", "users", "folders", "flows"] as const;
export type ProFeature = (typeof PRO_FEATURES)[number];

export const PRO_PRICE_USD = 49;

export interface LicensePayload {
  /** Who the license was issued to */
  licensee: string;
  email: string;
  plan: "pro";
  /** unix ms */
  issuedAt: number;
  /** unix ms, null = perpetual */
  expiresAt: number | null;
  /** free-form, e.g. "1.x" */
  notes?: string;
}

export interface Edition {
  tier: Tier;
  /** true when DEMO_MODE=true: pro unlocked, but with a "demo" badge and guarded settings */
  demo: boolean;
  features: Record<ProFeature, boolean>;
  license: (Pick<LicensePayload, "licensee" | "email" | "expiresAt" | "issuedAt"> & { valid: boolean }) | null;
  priceUsd: number;
  checkoutUrl: string;
}

// ---------------------------------------------------------------------------
// Users / auth
// ---------------------------------------------------------------------------

export const ROLES = ["admin", "operator", "viewer"] as const;
export type Role = (typeof ROLES)[number];

export interface User {
  id: string;
  email: string;
  name: string;
  role: Role;
  createdAt: string; // ISO
  lastLoginAt: string | null;
}

export const roleSchema = z.enum(ROLES);

export const setupSchema = z.object({
  email: z.string().email(),
  name: z.string().min(1).max(80),
  password: z.string().min(8).max(200),
});
export type SetupInput = z.infer<typeof setupSchema>;

export const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});
export type LoginInput = z.infer<typeof loginSchema>;

export const createUserSchema = z.object({
  email: z.string().email(),
  name: z.string().min(1).max(80),
  role: roleSchema,
  password: z.string().min(8).max(200),
});
export type CreateUserInput = z.infer<typeof createUserSchema>;

export const updateUserSchema = z.object({
  name: z.string().min(1).max(80).optional(),
  role: roleSchema.optional(),
  password: z.string().min(8).max(200).optional(),
});
export type UpdateUserInput = z.infer<typeof updateUserSchema>;

export interface MeResponse {
  user: User;
  edition: Edition;
}

export interface SetupStatus {
  needsSetup: boolean;
  demo: boolean;
}

// ---------------------------------------------------------------------------
// Redis connections
// ---------------------------------------------------------------------------

export interface RedisConnection {
  id: string;
  name: string;
  /** redis:// or rediss:// URL. Password is redacted in API responses. */
  url: string;
  /** BullMQ key prefix (default "bull") */
  prefix: string;
  cluster: boolean;
  /** Optional hard filter for queue discovery, glob-ish, e.g. "payments-*" */
  queueFilter: string | null;
  createdAt: string;
  status?: ConnectionStatus;
}

export interface ConnectionStatus {
  ok: boolean;
  latencyMs: number | null;
  redisVersion: string | null;
  error: string | null;
  checkedAt: string;
}

export const createConnectionSchema = z.object({
  name: z.string().min(1).max(80),
  url: z
    .string()
    .min(1)
    .refine((u) => /^rediss?:\/\//.test(u), "Must start with redis:// or rediss://"),
  prefix: z.string().min(1).max(64).default("bull"),
  cluster: z.boolean().default(false),
  queueFilter: z.string().max(200).nullable().optional(),
});
export type CreateConnectionInput = z.infer<typeof createConnectionSchema>;

export const updateConnectionSchema = createConnectionSchema.partial();
export type UpdateConnectionInput = z.infer<typeof updateConnectionSchema>;

export const testConnectionSchema = z.object({
  url: z.string().min(1),
  prefix: z.string().optional(),
  cluster: z.boolean().optional(),
});

export interface RedisServerInfo {
  redisVersion: string;
  mode: string;
  uptimeSeconds: number;
  connectedClients: number;
  usedMemoryBytes: number;
  usedMemoryHuman: string;
  maxMemoryBytes: number | null;
  totalKeys: number | null;
  opsPerSec: number | null;

  // --- health fields, for watching a production Redis while the dashboard runs ---
  /** used_memory_rss: what the OS actually holds */
  usedMemoryRssBytes: number | null;
  /** used_memory_peak */
  usedMemoryPeakBytes: number | null;
  /** mem_fragmentation_ratio: >1.5 means the allocator is wasting memory */
  memFragmentationRatio: number | null;
  /** maxmemory_policy, e.g. "noeviction". Matters: "noeviction" + full memory = writes fail */
  maxMemoryPolicy: string | null;
  /** cumulative CPU seconds burned by the Redis process (self, user+sys) */
  cpuSecondsTotal: number | null;
  /** blocked_clients: BRPOPLPUSH-style waits. Normal for BullMQ workers. */
  blockedClients: number | null;
  /** total_commands_processed, cumulative */
  totalCommandsProcessed: number | null;
  /** keyspace_hits / (hits+misses) as a percentage, null when nothing was read yet */
  keyspaceHitRatePct: number | null;
  /** evicted_keys, cumulative. Non-zero on a queue Redis means data loss. */
  evictedKeys: number | null;
  /** expired_keys, cumulative */
  expiredKeys: number | null;
  /** rejected_connections, cumulative. Non-zero means maxclients was hit. */
  rejectedConnections: number | null;
  /** connected_slaves / replicas */
  connectedReplicas: number | null;
  /** rdb_last_bgsave_status / aof_last_write_status: "ok" or a failure */
  persistenceOk: boolean | null;
  /** latency of the INFO round trip we just did, ms */
  latencyMs: number;
  /** when this snapshot was taken (ISO) */
  sampledAt: string;
}

/**
 * A point-in-time health sample of one connection, for the homepage monitor.
 * Rates are computed by the SERVER between polls, because INFO only gives
 * cumulative counters; the UI would otherwise have to diff them itself.
 */
export interface ConnectionHealth {
  connectionId: string;
  connectionName: string;
  ok: boolean;
  error: string | null;
  info: RedisServerInfo | null;
  /** commands/sec derived from total_commands_processed between the last two samples */
  commandsPerSec: number | null;
  /** CPU cores used, derived from used_cpu_sys+user between samples (1.0 = one full core) */
  cpuCores: number | null;
  /** memory used as a percentage of maxmemory, null when maxmemory is 0 (unlimited) */
  memoryUsedPct: number | null;
  /** rolling window of recent samples, oldest first, for sparklines */
  history: HealthPoint[];
  /** things worth shouting about, computed server-side so every client agrees */
  warnings: HealthWarning[];
}

export interface HealthPoint {
  /** unix ms */
  t: number;
  latencyMs: number;
  memoryBytes: number;
  commandsPerSec: number | null;
  cpuCores: number | null;
  connectedClients: number;
}

export interface HealthWarning {
  level: "warn" | "critical";
  code:
    | "memory_high"
    | "eviction"
    | "fragmentation"
    | "persistence_failed"
    | "rejected_connections"
    | "latency_high"
    | "unreachable";
  message: string;
}

// ---------------------------------------------------------------------------
// Queues / jobs
// ---------------------------------------------------------------------------

export const JOB_STATES = [
  "waiting",
  "active",
  "completed",
  "failed",
  "delayed",
  "prioritized",
  "paused",
  "waiting-children",
] as const;
export type JobState = (typeof JOB_STATES)[number];
export const jobStateSchema = z.enum(JOB_STATES);

export type QueueCounts = Record<JobState, number>;

export interface QueueMetrics {
  /** per-minute completed counts, oldest first. Empty when the queue does not collect metrics. */
  completed: number[];
  failed: number[];
}

/** Finished jobs inside a trailing window, from ZCOUNT on completed/failed (O(log N)). */
export interface QueueRates {
  windowMinutes: number;
  completed: number;
  failed: number;
  /** 0..100, null when nothing finished in the window */
  successPct: number | null;
}

export interface QueueSummary {
  name: string;
  prefix: string;
  counts: QueueCounts;
  isPaused: boolean;
  /** true when BullMQ Pro group keys exist for this queue or meta.version says bullmq-pro */
  isPro: boolean;
  groupsCount: number;
  /** success / failure over the trailing window (default 60 min) */
  rates: QueueRates;
  /** per-minute completed/failed points, when the queue collects metrics */
  metrics?: QueueMetrics;
}

/**
 * What Redis knows about how a queue is configured. Worker-side options
 * (worker concurrency, batch size) are NOT stored in Redis; fields that cannot
 * be observed are null and the UI says so instead of guessing.
 */
export interface QueueSetup {
  /** meta.version, e.g. "bullmq:5.81.4" or "bullmq-pro:7.x" */
  library: string | null;
  isPro: boolean;
  isPaused: boolean;
  /** meta.concurrency set via queue.setGlobalConcurrency() */
  globalConcurrency: number | null;
  /** meta.max + meta.duration set via queue.setGlobalRateLimit() */
  globalRateLimit: { max: number; durationMs: number } | null;
  /** the `limiter` key exists → a worker limiter is currently throttling; ttlMs until it lifts */
  rateLimitedNow: { ttlMs: number } | null;
  /** workers connected right now (CLIENT LIST names matching the queue); null if CLIENT LIST unavailable */
  workers: { count: number; names: string[] } | null;
  /** BullMQ Pro group settings observed in Redis */
  groups: {
    count: number;
    /** groups:max key exists → per-group concurrency limits configured */
    concurrencyLimited: boolean;
    /** groups:limit key exists → per-group rate limits configured */
    rateLimited: boolean;
    activeGroups: number;
    pausedGroups: number;
  } | null;
  /** worker `batch` option is not observable from Redis */
  batch: "unknown";
  metricsEnabled: boolean;
  maxLenEvents: number | null;
  /** every other meta field, for the "raw" disclosure */
  rawMeta: Record<string, string>;
}

export interface JobParentRef {
  id: string;
  /** full queue key, e.g. "bull:orders" */
  queueKey: string;
  /** derived queue name */
  queue: string;
}

export interface JobSummary {
  id: string;
  name: string;
  timestamp: number;
  processedOn: number | null;
  finishedOn: number | null;
  attemptsMade: number;
  attempts: number | null;
  failedReason: string | null;
  progress: number | string | Record<string, unknown> | null;
  delay: number;
  priority: number;
  /** stringified data, possibly truncated for list views */
  dataPreview: string;
  dataTruncated: boolean;
  parent: JobParentRef | null;
  /** BullMQ Pro group id if any */
  groupId: string | null;
  state: JobState | "unknown";
}

export interface JobDetail extends Omit<JobSummary, "dataPreview" | "dataTruncated"> {
  data: unknown;
  opts: Record<string, unknown>;
  returnvalue: unknown;
  stacktrace: string[];
  logs: string[];
  logsCount: number;
  /** remaining children for flow parents */
  dependencies: { processed: number; unprocessed: number } | null;
}

export interface JobsPage {
  jobs: JobSummary[];
  total: number;
  start: number;
  end: number;
}

export interface JobSearchResult {
  jobs: JobSummary[];
  /** opaque; pass back to continue scanning. null when the state is exhausted */
  nextCursor: string | null;
  scanned: number;
  total: number;
}

export interface GroupSummary {
  id: string;
  waiting: number;
  /** score in the groups zset (Pro uses it for fairness/ordering) */
  score: number;
  status: "active" | "waiting" | "paused" | "rate-limited" | "maxed" | "unknown";
}

export const addJobSchema = z.object({
  name: z.string().min(1).max(200).default("__default__"),
  data: z.unknown().default({}),
  opts: z.record(z.unknown()).default({}),
});
export type AddJobInput = z.infer<typeof addJobSchema>;

export const cleanQueueSchema = z.object({
  state: z.enum(["completed", "failed", "delayed", "wait", "active", "paused", "prioritized"]),
  /** ms */
  grace: z.number().int().min(0).default(0),
  limit: z.number().int().min(1).max(100000).default(1000),
});
export type CleanQueueInput = z.infer<typeof cleanQueueSchema>;

export const listJobsQuerySchema = z.object({
  state: jobStateSchema.default("waiting"),
  /** BullMQ Pro: restrict to a group's waiting list (state is ignored when set) */
  groupId: z.string().min(1).max(200).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(25),
  order: z.enum(["asc", "desc"]).default("desc"),
});

export const searchJobsQuerySchema = z.object({
  state: jobStateSchema.default("failed"),
  q: z.string().min(1).max(500),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

// ---------------------------------------------------------------------------
// Folders (Pro)
// ---------------------------------------------------------------------------

export interface FolderQueueRef {
  connectionId: string;
  queueName: string;
}

export interface Folder {
  id: string;
  name: string;
  color: string | null;
  parentId: string | null;
  position: number;
  queues: FolderQueueRef[];
}

export const createFolderSchema = z.object({
  name: z.string().min(1).max(80),
  color: z.string().max(20).nullable().optional(),
  parentId: z.string().nullable().optional(),
});
export const updateFolderSchema = createFolderSchema.partial().extend({
  position: z.number().int().min(0).optional(),
});
export const setFolderQueuesSchema = z.object({
  queues: z.array(z.object({ connectionId: z.string(), queueName: z.string() })),
});

// ---------------------------------------------------------------------------
// Alerts (Pro)
// ---------------------------------------------------------------------------

export const ALERT_KINDS = ["waiting_above", "failed_above", "failed_rate_above"] as const;
export type AlertKind = (typeof ALERT_KINDS)[number];

export const alertConditionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("waiting_above"), threshold: z.number().int().min(1) }),
  z.object({
    kind: z.literal("failed_above"),
    threshold: z.number().int().min(1),
    /** minutes; counts failures whose finishedOn falls inside the window */
    windowMinutes: z.number().int().min(1).max(1440).default(5),
  }),
  z.object({
    kind: z.literal("failed_rate_above"),
    percent: z.number().min(0.1).max(100),
    windowMinutes: z.number().int().min(1).max(1440).default(5),
    /** ignore windows with fewer finished jobs than this */
    minSample: z.number().int().min(1).default(20),
  }),
]);
export type AlertCondition = z.infer<typeof alertConditionSchema>;

/**
 * What an alert watches. A queue alert measures one queue; a folder alert
 * measures every queue in the folder (across connections) and fires when ANY
 * of them breaches, reporting the worst one.
 */
export const alertScopeSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("queue"), connectionId: z.string().min(1), queueName: z.string().min(1) }),
  z.object({ type: z.literal("folder"), folderId: z.string().min(1) }),
]);
export type AlertScope = z.infer<typeof alertScopeSchema>;

export const alertChannelSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("slack"), webhookUrl: z.string().url() }),
  z.object({
    type: z.literal("webhook"),
    url: z.string().url(),
    headers: z.record(z.string()).optional(),
  }),
]);
export type AlertChannel = z.infer<typeof alertChannelSchema>;

export const createAlertSchema = z.object({
  name: z.string().min(1).max(120),
  enabled: z.boolean().default(true),
  scope: alertScopeSchema,
  condition: alertConditionSchema,
  channels: z.array(alertChannelSchema).min(1),
  /** minutes to wait before re-notifying the same alert while it stays firing */
  cooldownMinutes: z.number().int().min(1).max(1440).default(30),
});
export type CreateAlertInput = z.infer<typeof createAlertSchema>;
export const updateAlertSchema = createAlertSchema.partial();

export interface Alert extends CreateAlertInput {
  id: string;
  createdAt: string;
  lastFiredAt: string | null;
  /** current evaluation state */
  firing: boolean;
}

export interface AlertEvent {
  id: string;
  alertId: string;
  alertName: string;
  /** the queue that triggered the event (worst queue for folder alerts); null when inconclusive */
  connectionId: string | null;
  queueName: string | null;
  kind: AlertKind;
  status: "fired" | "resolved" | "delivery_failed";
  message: string;
  value: number | null;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Flows (Pro)
// ---------------------------------------------------------------------------

export interface FlowNode {
  id: string; // queueName
  queueName: string;
  counts: QueueCounts;
  isPaused: boolean;
}

export interface FlowEdge {
  id: string;
  /** producing queue (the child in a BullMQ flow tree) */
  from: string;
  /** consuming queue (the parent that waits for children) */
  to: string;
  source: "detected" | "manual";
  /** number of sampled jobs that evidenced this edge (detected only) */
  evidence: number;
  label: string | null;
}

export interface FlowGraph {
  connectionId: string;
  nodes: FlowNode[];
  edges: FlowEdge[];
  sampledJobs: number;
}

export const createFlowEdgeSchema = z.object({
  connectionId: z.string(),
  from: z.string().min(1),
  to: z.string().min(1),
  label: z.string().max(120).nullable().optional(),
});

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export interface ApiError {
  error: string;
  message: string;
  /** set when error === "pro_required" */
  feature?: ProFeature;
  details?: unknown;
}

// ---------------------------------------------------------------------------
// Helpers shared by server + inspector
// ---------------------------------------------------------------------------

/** Which redis key holds each state, relative to `${prefix}:${queue}:` */
export const STATE_KEY: Record<JobState, { key: string; type: "list" | "zset" }> = {
  waiting: { key: "wait", type: "list" },
  active: { key: "active", type: "list" },
  completed: { key: "completed", type: "zset" },
  failed: { key: "failed", type: "zset" },
  delayed: { key: "delayed", type: "zset" },
  prioritized: { key: "prioritized", type: "zset" },
  paused: { key: "paused", type: "list" },
  "waiting-children": { key: "waiting-children", type: "zset" },
};

export const EMPTY_COUNTS: QueueCounts = {
  waiting: 0,
  active: 0,
  completed: 0,
  failed: 0,
  delayed: 0,
  prioritized: 0,
  paused: 0,
  "waiting-children": 0,
};

/** Role ordering used for permission checks: admin > operator > viewer */
export const ROLE_RANK: Record<Role, number> = { admin: 3, operator: 2, viewer: 1 };

export function hasRole(userRole: Role, required: Role): boolean {
  return ROLE_RANK[userRole] >= ROLE_RANK[required];
}

/** Redact the password part of a redis URL for display */
export function redactRedisUrl(url: string): string {
  try {
    const u = new URL(url);
    if (u.password) u.password = "****";
    return u.toString();
  } catch {
    return url.replace(/:\/\/([^:@/]*):([^@/]*)@/, "://$1:****@");
  }
}
