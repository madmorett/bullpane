/**
 * @bullpane/shared
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

export const PRO_FEATURES = ["alerts", "users", "folders", "flows", "audit"] as const;
export type ProFeature = (typeof PRO_FEATURES)[number];

/**
 * Pro pricing (USD). A subscription, one installation per license key.
 * Yearly is 12 months for the price of ~8 (35% off).
 */
export const PRO_PRICING = { monthlyUsd: 19, yearlyUsd: 149 } as const;
export interface ProPricing {
  monthlyUsd: number;
  yearlyUsd: number;
}

/**
 * "subscription" keys are sold on bullpane.com and verified online (see
 * LicenseInfo.source). "perpetual" keys are hand-signed for customers who cannot
 * phone home (air-gapped, procurement) and never talk to the license API.
 */
export type LicenseBilling = "subscription" | "perpetual";

/**
 * Signed document inside a license token. Two producers:
 *  - scripts/gen-license.ts (offline, perpetual keys)
 *  - the license API at api.bullpane.com (short-lived *leases* for subscription
 *    keys: `expiresAt` is the lease end, `activationId` ties it to one install)
 */
export interface LicensePayload {
  /** Who the license was issued to */
  licensee: string;
  email: string;
  plan: "pro";
  /** unix ms */
  issuedAt: number;
  /** unix ms, null = perpetual. For a lease: when the lease stops working offline. */
  expiresAt: number | null;
  /** free-form, e.g. "1.x" */
  notes?: string;
  /** lease only: the activation this lease was issued for */
  activationId?: string;
  /** lease only: end of the paid period as reported by the store, null = open subscription */
  subscriptionExpiresAt?: number | null;
  billing?: LicenseBilling;
}

export type LicenseSource = "offline" | "online";

/**
 * active  – valid, last online check (if any) succeeded
 * grace   – online key, lease still valid but the last check could not reach the API
 * expired – lease or perpetual key past its end date
 * invalid – signature failed, or the store said revoked / not found / used elsewhere
 */
export type LicenseStatus = "active" | "grace" | "expired" | "invalid";

export interface LicenseInfo {
  licensee: string;
  email: string;
  /** unix ms */
  issuedAt: number;
  /** unix ms. offline: key expiry. online: end of the paid period (null = open subscription) */
  expiresAt: number | null;
  valid: boolean;
  source: LicenseSource;
  billing: LicenseBilling;
  status: LicenseStatus;
  /** online only. unix ms after which the install falls back to free unless refreshed */
  leaseExpiresAt: number | null;
  /** online only. unix ms of the last successful or failed contact with the license API */
  lastCheckedAt: number | null;
  /** online only. Why the last check failed, human readable. null when it succeeded */
  lastCheckError: string | null;
  /** online only. Short id shown so support can match it in the store */
  activationId: string | null;
}

export interface Edition {
  tier: Tier;
  /** true when DEMO_MODE=true: pro unlocked, but with a "demo" badge and guarded settings */
  demo: boolean;
  features: Record<ProFeature, boolean>;
  license: LicenseInfo | null;
  pricing: ProPricing;
  checkoutUrl: string;
}

// ---------------------------------------------------------------------------
// License API (api.bullpane.com) — contract shared by the server client and the worker
// ---------------------------------------------------------------------------

export const LICENSE_API_ERROR_CODES = [
  /** the key does not exist in the store */
  "license_not_found",
  /** activation limit reached: the key is already active on another installation */
  "license_activation_limit",
  /** the subscription was cancelled or the key disabled */
  "license_revoked",
  /** the paid period ended */
  "license_expired",
  /** the activation this install holds no longer exists (deactivated from the portal) */
  "license_activation_mismatch",
  /** the store (Polar) could not be reached or answered 5xx */
  "upstream_unavailable",
  "validation",
] as const;
export type LicenseApiErrorCode = (typeof LICENSE_API_ERROR_CODES)[number];

/**
 * Codes that are a final answer about the key. The server drops to free at once
 * on these; anything else keeps the current lease until it runs out.
 */
export const LICENSE_API_DEFINITIVE_CODES: readonly LicenseApiErrorCode[] = [
  "license_not_found",
  "license_activation_limit",
  "license_revoked",
  "license_expired",
  "license_activation_mismatch",
];

export const licenseKeySchema = z.string().trim().min(8).max(512);

export const licenseActivateRequestSchema = z.object({
  key: licenseKeySchema,
  instance: z.object({
    /** hostname + public URL, so the customer recognises it in the portal */
    label: z.string().trim().min(1).max(120),
    version: z.string().max(40).optional(),
  }),
});
export type LicenseActivateRequest = z.infer<typeof licenseActivateRequestSchema>;

export const licenseRefreshRequestSchema = z.object({
  key: licenseKeySchema,
  activationId: z.string().trim().min(1).max(120),
});
export type LicenseRefreshRequest = z.infer<typeof licenseRefreshRequestSchema>;
export type LicenseDeactivateRequest = LicenseRefreshRequest;

export interface LicenseLeaseResponse {
  /** base64url(payload).base64url(signature), a LicensePayload with activationId */
  lease: string;
}

export interface LicenseApiError {
  error: LicenseApiErrorCode;
  message: string;
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

/**
 * Success / failure over a trailing window.
 *
 * There are two possible sources, and they are NOT equally trustworthy:
 *
 *  - `metrics` — BullMQ's own per-minute counters (`metrics:completed:data`).
 *    These are cumulative counts recorded when each job finishes, so they stay
 *    correct no matter how aggressively `removeOnComplete` prunes the zsets.
 *    Only available when the Worker was created with `metrics: { maxDataPoints }`.
 *
 *  - `zset` — ZCOUNT over the completed/failed sorted sets. Only counts jobs
 *    that are STILL THERE. With `removeOnComplete: { count: 50 }` and a
 *    `removeOnFail` that keeps more, the ratio is badly skewed: 10.000 ok and
 *    100 failed reads as 50/(50+100) = 33% instead of 99%.
 *
 * The UI must label a `zset` reading as unreliable whenever `retentionSkewed`
 * is true, and point people at enabling metrics.
 */
export interface QueueRates {
  windowMinutes: number;
  completed: number;
  failed: number;
  /** 0..100, null when nothing finished in the window */
  successPct: number | null;
  /** where the numbers came from */
  source: "metrics" | "zset";
  /**
   * true when source is "zset" AND the queue prunes completed jobs, so the
   * ratio is probably wrong. Derived from meta/opts retention settings.
   */
  retentionSkewed: boolean;
}

export interface QueueSummary {
  name: string;
  prefix: string;
  counts: QueueCounts;
  isPaused: boolean;
  /** true when BullMQ Pro group keys exist for this queue or meta.version says bullmq-pro */
  isPro: boolean;
  groupsCount: number;
  /** job schedulers (repeatable jobs) configured on this queue — ZCARD of `repeat` */
  schedulersCount: number;
  /**
   * SCARD de `${prefix}:${queue}:stalled` — jobs que o BullMQ marcou como
   * stallados nesta rodada do StalledCheck.
   *
   * Deliberadamente NÃO é um `JobState` e nunca aparece em `counts`: no modelo
   * do BullMQ um job stallado continua `active` (o worker morreu sem renovar o
   * lock). Fingir um estado "stalled" mentiria sobre o modelo. Este número
   * existe para a aba `active` poder dizer "3 destes estão travados".
   */
  stalledCount: number;
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
  /**
   * Hash field `stc` (lido por `Job.fromJSON` como `stalledCounter`): quantas
   * vezes este job foi recuperado por ter stallado — o worker perdeu o lock e
   * o StalledCheck devolveu o job para `wait`.
   *
   * NÃO é um estado. `stalled` é um SET auxiliar (`${prefix}:${queue}:stalled`);
   * `getState()` de um job stallado devolve `active`. Um valor > 0 aqui é o
   * único rastro, no próprio job, de que ele já travou uma vez.
   */
  stalledCounter: number;
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

/**
 * A BullMQ **job scheduler** (what used to be called a "repeatable job").
 *
 * Schedulers do NOT live in any of the 8 job states: BullMQ keeps them in
 * `${prefix}:${queue}:repeat` (a zset id -> next run millis) plus one hash per
 * scheduler at `${prefix}:${queue}:repeat:${key}`. The hash carries exactly the
 * fields below — verified against bullmq 5.81.4 (`classes/job-scheduler.js`,
 * `transformSchedulerData`) and against a live Redis.
 *
 * A scheduler produces at most one delayed job at a time; that job is named
 * `repeat:${key}:${millis}` and lives in `delayed`. So the scheduler list is the
 * only place a user can see "what is going to run, and when".
 */
export interface JobScheduler {
  /** the job scheduler id passed to `upsertJobScheduler` (hash suffix + zset member) */
  key: string;
  /** name given to the jobs it produces (defaults to the scheduler id) */
  name: string;
  /** next run, unix ms — the score in the `repeat` zset. null when the zset lost the member */
  next: number | null;
  /** cron expression, when the scheduler repeats on a pattern */
  pattern: string | null;
  /** fixed interval in ms, when the scheduler repeats every N ms */
  every: number | null;
  /** IANA timezone applied to `pattern` */
  tz: string | null;
  /** ms offset applied to the first run (bullmq `offset`) */
  offset: number | null;
  /** stop producing after this unix ms */
  endDate: number | null;
  /** do not produce before this unix ms */
  startDate: number | null;
  /** max number of jobs this scheduler will ever produce */
  limit: number | null;
  /** how many jobs it produced so far (hash field `ic`), null on legacy repeatables */
  iterationCount: number | null;
  /** the job it stamps out. `data`/`opts` are raw JSON strings, truncated for list views */
  template: { name: string; data: string | null; opts: string | null } | null;
}

export interface SchedulersPage {
  schedulers: JobScheduler[];
  total: number;
  start: number;
  end: number;
}

export const listSchedulersQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(25),
});

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

// ---------------------------------------------------------------------------
// Ações em lote sobre jobs (retry / remove / promote)
//
// Entre "um job" e "todos os 1.000 de um estado" não havia nada, e o caso real
// é o do meio: os erros vêm agrupados (um webhook de um tenant devolvendo 410),
// a busca server-side acha exatamente esses 50 e o operador quer agir sobre eles.
//
// Duas decisões que moldam o contrato:
//
//  1. TETO POR CHAMADA (`BULK_JOB_LIMIT`). Sem teto alguém cola 100 mil ids e
//     prende o Redis — contraria o contrato de performance. O limite é validado
//     no zod, então a recusa é 400 com a mensagem explicando, não um timeout.
//  2. RESULTADO PARCIAL É A REGRA. Um id pode ter sido podado, estar noutro
//     estado ou falhar no script atômico do BullMQ. Abortar no primeiro erro
//     esconderia os 47 que deram certo, então a resposta é 200 com
//     `{ ok, failed }` e o operador vê exatamente quais 3 dos 50 não foram.
// ---------------------------------------------------------------------------

/** Teto de ids por chamada em lote. Ver o comentário acima. */
export const BULK_JOB_LIMIT = 500;

export const BULK_JOB_ACTIONS = ["retry", "remove", "promote"] as const;
export type BulkJobAction = (typeof BULK_JOB_ACTIONS)[number];

export const bulkJobActionSchema = z.object({
  jobIds: z
    .array(z.string().min(1).max(200))
    .min(1, "jobIds must not be empty")
    .max(BULK_JOB_LIMIT, `at most ${BULK_JOB_LIMIT} job ids per call`),
});
export type BulkJobActionInput = z.infer<typeof bulkJobActionSchema>;

export interface BulkJobFailure {
  jobId: string;
  /** motivo curto e legível ("job_not_found", "cannot_retry_job_in_state_active") */
  reason: string;
}

export interface BulkJobActionResult {
  action: BulkJobAction;
  /** ids em que a ação foi aplicada */
  ok: string[];
  /** ids que não foram, com o porquê — nunca silenciados */
  failed: BulkJobFailure[];
  /** quantos ids foram pedidos (ok.length + failed.length) */
  requested: number;
}

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
// Hidden queues (free)
//
// Hiding a queue removes it from every LIST in the UI (overview cards, the
// connection table, the sidebar, the folder picker, the alert queue selector).
// It does NOT touch Redis: no key is written, no job is removed. It is the
// opposite of `obliterate`, which deletes the queue and every job in it and
// cannot be undone.
//
// Scope is per INSTANCE, not per user: a dead queue is dead for the whole team,
// and a dashboard that looks different for each person is a liability during an
// incident. `hiddenBy` records who did it so the choice is auditable, not
// personal. Minimum role is `operator` — the same level as pausing a queue.
// ---------------------------------------------------------------------------

export interface HiddenQueue {
  connectionId: string;
  queueName: string;
  /** ISO timestamp */
  hiddenAt: string;
  /** user id, or null when the user was deleted */
  hiddenBy: string | null;
  /** display name of `hiddenBy`, resolved by the server; null when unknown */
  hiddenByName: string | null;
}

export const hideQueueSchema = z.object({
  queueName: z.string().min(1).max(255),
});
export type HideQueueInput = z.infer<typeof hideQueueSchema>;

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

/** Error-rate conditions are measured from BullMQ metrics counters ONLY (see AlertMeasurement). */
export const ERROR_ALERT_KINDS = ["failed_above", "failed_rate_above"] as const;
export function isErrorAlertKind(kind: AlertKind): boolean {
  return (ERROR_ALERT_KINDS as readonly string[]).includes(kind);
}

/**
 * Why an error alert may not be able to judge anything right now.
 *
 * `failed_above` / `failed_rate_above` are measured by diffing BullMQ's own
 * cumulative counters (`${prefix}:${queue}:metrics:completed|failed` field
 * `count`) between two ticks. That is the ONLY honest source: `ZCOUNT` over the
 * completed/failed zsets counts jobs that are still there, so a queue with
 * `removeOnComplete` reads as a queue that fails constantly (measured: 300 ok /
 * 15 failed = 4.8% real, but 50 ok / 15 failed = 23% by ZCOUNT). There is no
 * fallback on purpose: no alert beats a lying alert.
 *
 *  - `ok`         — two samples far enough apart exist, the number is real.
 *  - `warming_up` — the engine has samples but none older than the configured
 *    window yet (fresh process, new alert, just-widened window). Nothing fires.
 *  - `no_metrics` — the queue's Worker was not created with
 *    `metrics: { maxDataPoints }`, so BullMQ keeps no counters and the alert is
 *    inert. Nothing fires, and one informative event says so.
 */
export type AlertMeasurementState = "ok" | "warming_up" | "no_metrics";

export interface AlertMeasurement {
  /** always "metrics" for error alerts; "counts" for the waiting gauge */
  source: "metrics" | "counts";
  state: AlertMeasurementState;
  /** ms of real history the delta covers; null when nothing could be measured */
  windowCoveredMs: number | null;
  /** queues (of a folder alert) that do not collect metrics, for the UI to name */
  queuesWithoutMetrics?: string[];
}

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
  /**
   * What the last evaluation could actually see. Absent until the engine has
   * ticked once on this alert (or when the edition has alerts locked). The UI
   * must show `warming_up` / `no_metrics` instead of a green "ok".
   */
  measurement?: AlertMeasurement | null;
}

export interface AlertEvent {
  id: string;
  alertId: string;
  alertName: string;
  /** the queue that triggered the event (worst queue for folder alerts); null when inconclusive */
  connectionId: string | null;
  queueName: string | null;
  kind: AlertKind;
  /** `no_metrics` is informative: the alert cannot measure and did NOT fire. */
  status: AlertEventStatus;
  message: string;
  value: number | null;
  createdAt: string;
}

export const ALERT_EVENT_STATUSES = ["fired", "resolved", "delivery_failed", "no_metrics"] as const;
export type AlertEventStatus = (typeof ALERT_EVENT_STATUSES)[number];

// ---------------------------------------------------------------------------
// Audit log (Pro)
//
// Every mutating API call lands here: who, what, on which connection/queue/job,
// whether it worked, and the parameters of the action. This is the trail an
// auditor asks for ("who paused the payments queue on the 14th?") and the one
// bull-board cannot produce because it has no users at all.
//
// Two rules that shape the whole design:
//
//  1. **The actor is denormalised.** actorEmail/actorName/actorRole are copied
//     into the row at write time. A log whose only pointer to the person is a
//     foreign key becomes worthless the day that user is deleted — which is
//     exactly the day you need it.
//  2. **`detail` never carries a job payload.** It holds the PARAMETERS of the
//     action (clean state/grace/limit, how many jobs were removed, the job NAME
//     added, the alert id), never `job.data`, which routinely contains customer
//     PII. Size in bytes is recorded instead when useful.
// ---------------------------------------------------------------------------

export const AUDIT_ACTIONS = [
  // jobs
  "job.add",
  "job.retry",
  "job.remove",
  "job.promote",
  "job.discard",
  "job.bulk_retry",
  "job.bulk_remove",
  "job.bulk_promote",
  // queues
  "queue.pause",
  "queue.resume",
  "queue.clean",
  "queue.retry_all",
  "queue.drain",
  "queue.obliterate",
  "scheduler.remove",
  "queue.hide",
  "queue.unhide",
  // settings
  "connection.create",
  "connection.update",
  "connection.delete",
  "user.create",
  "user.update",
  "user.delete",
  "alert.create",
  "alert.update",
  "alert.delete",
  "license.set",
  "license.remove",
  // auth
  "auth.login",
  "auth.login_failed",
  "auth.logout",
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

export type AuditResult = "ok" | "error";

/** Human wording for the UI. "reprocessou job", not `job.retry`. */
export const AUDIT_ACTION_LABEL: Record<AuditAction, string> = {
  "job.add": "added a job",
  "job.retry": "retried a job",
  "job.remove": "removed a job",
  "job.promote": "promoted a job",
  "job.discard": "discarded a job",
  "job.bulk_retry": "retried jobs in bulk",
  "job.bulk_remove": "removed jobs in bulk",
  "job.bulk_promote": "promoted jobs in bulk",
  "queue.pause": "paused the queue",
  "queue.resume": "resumed the queue",
  "queue.clean": "cleaned the queue",
  "queue.retry_all": "retried every job in a state",
  "queue.drain": "drained the queue",
  "queue.obliterate": "obliterated the queue",
  "scheduler.remove": "removed a job scheduler",
  "queue.hide": "hid the queue",
  "queue.unhide": "unhid the queue",
  "connection.create": "added a connection",
  "connection.update": "edited a connection",
  "connection.delete": "deleted a connection",
  "user.create": "invited a user",
  "user.update": "edited a user",
  "user.delete": "deleted a user",
  "alert.create": "created an alert",
  "alert.update": "edited an alert",
  "alert.delete": "deleted an alert",
  "license.set": "applied a license key",
  "license.remove": "removed the license key",
  "auth.login": "signed in",
  "auth.login_failed": "failed to sign in",
  "auth.logout": "signed out",
};

/**
 * Actions that destroy data or change who can get in. The UI marks these so a
 * page of 200 rows still shows the three that matter.
 */
export const AUDIT_HIGH_RISK_ACTIONS: readonly AuditAction[] = [
  "queue.obliterate",
  "queue.drain",
  "queue.clean",
  "job.remove",
  // Remover 50 jobs de uma vez destrói mais dado que remover um; entra aqui
  // pelo mesmo motivo que `job.remove`.
  "job.bulk_remove",
  "connection.delete",
  "user.create",
  "user.update",
  "user.delete",
  "license.set",
  "license.remove",
  "auth.login_failed",
];

export interface AuditEntry {
  id: string;
  /** ISO timestamp */
  createdAt: string;
  /** null for an anonymous call (a failed login on an unknown email) */
  actorId: string | null;
  /** copied at write time so the row survives the user being deleted */
  actorEmail: string | null;
  actorName: string | null;
  actorRole: Role | null;
  action: AuditAction;
  connectionId: string | null;
  /** name the connection had when the action happened */
  connectionName: string | null;
  queueName: string | null;
  jobId: string | null;
  result: AuditResult;
  /** the API error message when result === "error" (e.g. "forbidden") */
  errorMessage: string | null;
  /** action parameters. NEVER a job payload — see the rules above. */
  detail: Record<string, unknown> | null;
  ip: string | null;
  userAgent: string | null;
}

export interface AuditPage {
  entries: AuditEntry[];
  /** pass back as `cursor` for the next page; null when this is the last one */
  nextCursor: string | null;
}

export const auditActionSchema = z.enum(AUDIT_ACTIONS);

/**
 * Filters for GET /audit and GET /audit/export. Paging is keyset (createdAt,id)
 * rather than OFFSET: the table only grows, and an auditor scrolling page 40 of
 * a million rows must not cost a full sort.
 */
export const listAuditQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  /** opaque keyset cursor from AuditPage.nextCursor */
  cursor: z.string().max(200).optional(),
  actorId: z.string().max(36).optional(),
  action: auditActionSchema.optional(),
  connectionId: z.string().max(36).optional(),
  queueName: z.string().max(255).optional(),
  jobId: z.string().max(255).optional(),
  result: z.enum(["ok", "error"]).optional(),
  /** ISO date/datetime, inclusive */
  from: z.string().datetime({ offset: true }).optional(),
  /** ISO date/datetime, exclusive */
  to: z.string().datetime({ offset: true }).optional(),
});
export type ListAuditQuery = z.infer<typeof listAuditQuerySchema>;

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
