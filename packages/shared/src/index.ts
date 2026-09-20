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

export const PRO_FEATURES = ["alerts", "users", "folders", "flows", "audit", "sso"] as const;
export type ProFeature = (typeof PRO_FEATURES)[number];

/**
 * Pro pricing (USD). A subscription, one installation per license key.
 * Yearly is 12 months for the price of ~8 (35% off).
 */
export const PRO_PRICING = { monthlyUsd: 39, yearlyUsd: 390 } as const;
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
  /** the store (Creem) could not be reached or answered 5xx */
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
  /**
   * ISO timestamp of when an admin disabled the account, null while active.
   * Users are disabled rather than deleted so their id keeps resolving in the
   * audit log and everywhere else it was recorded; a disabled user has no
   * session and cannot sign in by password or SSO until re-enabled.
   */
  disabledAt: string | null;
}

/**
 * The free edition has no login: `authPlugin` puts this synthetic admin on
 * every request that arrives without a session, so the ~40 `requireRole`
 * guards keep working untouched instead of each route learning about editions.
 *
 * The id is a literal, not a row in `users` — nothing can log in as it, and
 * `users.count() === 0` still drives the Pro setup flow. Audit rows written
 * under it are the honest answer to "who did this" on an install where
 * anyone with the URL could have.
 */
export const ANONYMOUS_USER_ID = "anonymous";

export function anonymousUser(): User {
  return {
    id: ANONYMOUS_USER_ID,
    email: "",
    name: "Anonymous",
    role: "admin",
    disabledAt: null,
    createdAt: new Date(0).toISOString(),
    lastLoginAt: null,
  };
}

export function isAnonymousUser(user: Pick<User, "id"> | null | undefined): boolean {
  return user?.id === ANONYMOUS_USER_ID;
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
  /**
   * Omit to create an SSO-only account: the row gets a NULL password hash and
   * that person can ONLY sign in through the identity provider (verifyPassword
   * refuses a null hash, so the escape hatch does not apply to them either).
   * Inventing a password for an SSO user would mean a credential nobody
   * rotates, which is precisely what SSO is bought to remove.
   */
  password: z.string().min(8).max(200).optional(),
});
export type CreateUserInput = z.infer<typeof createUserSchema>;

export const updateUserSchema = z.object({
  name: z.string().min(1).max(80).optional(),
  role: roleSchema.optional(),
  password: z.string().min(8).max(200).optional(),
  /** true disables the account (sessions revoked, logins refused); false re-enables it */
  disabled: z.boolean().optional(),
});
export type UpdateUserInput = z.infer<typeof updateUserSchema>;

export interface MeResponse {
  user: User;
  edition: Edition;
}

export interface SetupStatus {
  needsSetup: boolean;
  demo: boolean;
  /**
   * false on the free edition: there is no login at all, the UI goes straight
   * to the dashboard as an anonymous admin. True once a license unlocks
   * `users`, which is what makes accounts, roles and the login page exist.
   */
  authRequired: boolean;
}

// ---------------------------------------------------------------------------
// SSO (Pro)
// ---------------------------------------------------------------------------

/**
 * Single sign-on, configured by the customer's admin in the UI (not by env
 * vars): a self-hosted install has no vendor to file a ticket with, so the
 * whole provider lives in MySQL and can be fixed from the browser.
 *
 * There is deliberately NO just-in-time provisioning. The IdP proves who
 * somebody is; it does not decide that they get a Bullpane account, nor which
 * role. Login resolves the asserted email against an existing `users` row and
 * refuses when there is none (audit action `auth.sso_denied`). Consequence the
 * admin must know: inviting the person in Users & roles is still step one.
 */
export const SSO_KINDS = ["oidc", "saml"] as const;
export type SsoKind = (typeof SSO_KINDS)[number];

/**
 * OIDC. `issuer` is the only endpoint the admin types: everything else comes
 * from `${issuer}/.well-known/openid-configuration` at login time, so a
 * provider that rotates its endpoints or keys keeps working. PKCE is always on
 * and not configurable — there is no reason to offer the weaker flow.
 */
export const ssoOidcConfigSchema = z.object({
  issuer: z.string().url(),
  clientId: z.string().min(1).max(255),
  /**
   * Write-only. Present when creating or replacing the secret, absent when the
   * admin edits the name and leaves the secret alone. Never returned by the API.
   */
  clientSecret: z.string().min(1).max(500).optional(),
  /** Defaults to the OIDC minimum that yields an email. */
  scopes: z.array(z.string().min(1).max(60)).max(20).optional(),
  /**
   * Which claim carries the email. Overridable because some IdPs (notably
   * older ADFS/Entra setups) put it in `upn` or `preferred_username`.
   */
  emailClaim: z.string().min(1).max(60).optional(),
});
export type SsoOidcConfig = z.infer<typeof ssoOidcConfigSchema>;

/**
 * SAML 2.0. The IdP's signing certificate is mandatory and there is no
 * "skip signature validation" option: an unsigned assertion is a login form
 * that anybody on the internet can fill in.
 */
export const ssoSamlConfigSchema = z.object({
  entryPoint: z.string().url(),
  issuer: z.string().min(1).max(255),
  /** IdP signing certificate, PEM or bare base64. */
  idpCert: z.string().min(1).max(10000),
  emailAttribute: z.string().min(1).max(200).optional(),
});
export type SsoSamlConfig = z.infer<typeof ssoSamlConfigSchema>;

export const DEFAULT_OIDC_SCOPES = ["openid", "email", "profile"] as const;
export const DEFAULT_OIDC_EMAIL_CLAIM = "email";
/** The SAML attribute IdPs most often use for email, when the admin sets none. */
export const DEFAULT_SAML_EMAIL_ATTRIBUTE = "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress";

export const createSsoProviderSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("oidc"),
    name: z.string().min(1).max(60),
    enabled: z.boolean().optional(),
    config: ssoOidcConfigSchema.extend({ clientSecret: z.string().min(1).max(500) }),
  }),
  z.object({
    kind: z.literal("saml"),
    name: z.string().min(1).max(60),
    enabled: z.boolean().optional(),
    config: ssoSamlConfigSchema,
  }),
]);
export type CreateSsoProviderInput = z.infer<typeof createSsoProviderSchema>;

/** `kind` is immutable: changing protocol means a different provider. */
export const updateSsoProviderSchema = z.object({
  name: z.string().min(1).max(60).optional(),
  enabled: z.boolean().optional(),
  config: z.union([ssoOidcConfigSchema.partial(), ssoSamlConfigSchema.partial()]).optional(),
});
export type UpdateSsoProviderInput = z.infer<typeof updateSsoProviderSchema>;

/**
 * A provider as the admin API returns it. The client secret is never here —
 * `hasSecret` is how the UI knows whether to render "replace secret" instead of
 * "set secret".
 */
export interface SsoProvider {
  id: string;
  kind: SsoKind;
  name: string;
  enabled: boolean;
  /** Secrets stripped. Same shape as the input config minus write-only fields. */
  config: Record<string, unknown>;
  hasSecret: boolean;
  /** Where the admin must point the IdP. Derived from PUBLIC_URL, not stored. */
  callbackUrl: string;
  /** SAML only: the SP entity id to enter at the IdP. */
  entityId: string | null;
  createdAt: string; // ISO
  updatedAt: string; // ISO
}

/**
 * What the *login page* is allowed to know, before anybody is authenticated:
 * enough to draw the buttons, and nothing else. Unauthenticated endpoint, so it
 * carries no issuer, no client id and no hint about the customer's IdP.
 */
export interface SsoLoginOption {
  id: string;
  kind: SsoKind;
  name: string;
}

export interface SsoLoginOptions {
  providers: SsoLoginOption[];
  /**
   * true when the admin turned on "require SSO". The password form is hidden,
   * but see `passwordEscapeHatch`: it is never fully gone.
   */
  requireSso: boolean;
  /**
   * Whether a password login can still succeed despite `requireSso`, and for
   * whom. An IdP misconfigured on a self-hosted install would otherwise lock
   * the customer out of their own dashboard with nobody to call.
   *  - "admins": admin accounts may still use a password (the default)
   *  - "all": BULLPANE_ALLOW_PASSWORD_LOGIN=true overrides the toggle entirely
   *  - "none": only reachable when requireSso is false, i.e. nothing to escape
   */
  passwordEscapeHatch: "admins" | "all" | "none";
}

export const ssoSettingsSchema = z.object({
  requireSso: z.boolean(),
});
export type SsoSettings = z.infer<typeof ssoSettingsSchema>;

/** Result of "test connection" — discovery only, no login performed. */
export interface SsoTestResult {
  ok: boolean;
  message: string;
  /** OIDC: the endpoints discovery resolved, so the admin can eyeball them. */
  details?: Record<string, string>;
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
  /** Manual sidebar order, ascending. Global, not per user. */
  position: number;
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

/**
 * Reordering sends the WHOLE list of ids in their new order, not one position at
 * a time. Two reasons: a drag is one user action and should be one request that
 * either lands or does not, and per-item updates race — two people dragging at
 * once can leave duplicate positions that no later write repairs.
 */
export const reorderSchema = z.object({
  ids: z.array(z.string().min(1)).min(1),
});
export type ReorderInput = z.infer<typeof reorderSchema>;

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
   * SCARD of `${prefix}:${queue}:stalled` — jobs BullMQ flagged as stalled in
   * this round of the StalledCheck.
   *
   * Deliberately NOT a `JobState` and it never shows up in `counts`: in BullMQ's
   * model a stalled job is still `active` (the worker died without renewing the
   * lock). Faking a "stalled" state would lie about the model. This number
   * exists so the `active` tab can say "3 of these are stuck".
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
  /** BullMQ Pro groups observed in Redis; null when the queue shows no Pro signal */
  groups: {
    /** groups that currently hold jobs, across the four status zsets */
    count: number;
    byStatus: GroupsByStatus;
    /** groups with a per-group override (concurrency and/or rate limit) — the groups:metas zset */
    configured: number;
    /**
     * groups with at least one job being processed — HLEN groups:active:count.
     * Pro only maintains that hash when the worker runs with group.concurrency.
     */
    active: number;
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
  /**
   * Unix ms at which a `delayed` job becomes runnable, decoded from its score in
   * the `delayed` zset (`timestamp * 0x1000 + jobId % 0x1000`, the encoding
   * BullMQ has used since Bull 3). The hash's `delay` field is NOT enough: after
   * a backoff retry or `moveToDelayed` it holds the relative delay of that move,
   * with no record of when the move happened. null for every other state.
   */
  delayedUntil: number | null;
  priority: number;
  /** stringified data, possibly truncated for list views; "" when the payload was not read (see dataBytes) */
  dataPreview: string;
  dataTruncated: boolean;
  /**
   * Size of the `data` field in bytes (HSTRLEN, O(1)). Payloads above the
   * inspector's list cap are not copied out of Redis at all: dataPreview is ""
   * and dataTruncated is true — the UI shows the size and links to the job.
   * null on older servers that did not report it.
   */
  dataBytes: number | null;
  parent: JobParentRef | null;
  /** BullMQ Pro group id if any */
  groupId: string | null;
  /**
   * Hash field `stc` (read by `Job.fromJSON` as `stalledCounter`): how many
   * times this job was recovered for having stalled — the worker lost the lock
   * and the StalledCheck put the job back into `wait`.
   *
   * NOT a state. `stalled` is an auxiliary SET (`${prefix}:${queue}:stalled`);
   * `getState()` on a stalled job returns `active`. A value > 0 here is the only
   * trace, on the job itself, that it got stuck at least once.
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
  /** jobs whose data was over the search size cap: matched on id / name / error only */
  skippedLargePayloads: number;
}

/**
 * Where queue discovery stands for a connection. Discovery is a SCAN over the
 * keyspace with a per-pass budget, so on a Redis with millions of keys the first
 * full pass takes several passes; queues with a live worker are found at once
 * through CLIENT LIST regardless.
 */
export interface DiscoveryStatus {
  /** at least one full SCAN cycle has completed since the process started */
  complete: boolean;
  /** SCAN iterations spent so far in the current cycle */
  scannedIterations: number;
  /** keys in the keyspace (DBSIZE), for the UI to size the wait */
  totalKeys: number | null;
}

/**
 * BullMQ Pro group statuses, in Pro's own vocabulary (QueuePro.getGroupsCountByStatus).
 * A group is in exactly one of them: the four status zsets are disjoint.
 */
export const GROUP_STATUSES = ["waiting", "limited", "maxed", "paused"] as const;
export type GroupStatus = (typeof GROUP_STATUSES)[number];
export type GroupsByStatus = Record<GroupStatus, number>;

export interface GroupRateLimit {
  max: number;
  durationMs: number;
}

export interface GroupSummary {
  id: string;
  status: GroupStatus;
  /** jobs waiting in the group: its list plus its prioritized zset */
  waiting: number;
  /** the part of `waiting` that came with opts.priority (`groups:${id}:p`) */
  prioritized: number;
  /**
   * jobs of this group being processed right now (groups:active:count). Pro only
   * tracks it when the worker runs with group.concurrency; 0 otherwise.
   */
  active: number;
  /** per-group override (queue.setGroupConcurrency); null = the worker's group.concurrency applies */
  concurrency: number | null;
  /** per-group override (queue.setGroupRateLimit); null = the worker's group.limit applies */
  rateLimit: GroupRateLimit | null;
  /** status "limited": unix ms when Pro puts the group back in rotation */
  limitedUntil: number | null;
  /** status "maxed" / "paused": unix ms the group entered that status */
  since: number | null;
}

export interface GroupsPage {
  groups: GroupSummary[];
  total: number;
  byStatus: GroupsByStatus;
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

/** One scheduler plus the queue it belongs to — the row of the connection-wide list. */
export interface ConnectionScheduler extends JobScheduler {
  queueName: string;
}

/**
 * Every job scheduler of one connection, in one read.
 *
 * Fanned out over the queues that reported `schedulersCount > 0` in the stats
 * call the sidebar already makes, so it costs nothing on queues that have none.
 * `queuesScanned` / `queuesWithSchedulers` let the UI say what it actually looked at.
 */
export interface ConnectionSchedulersPage {
  schedulers: ConnectionScheduler[];
  total: number;
  queuesScanned: number;
  queuesWithSchedulers: number;
  /** queues whose scheduler read failed; the rest of the page is still valid */
  failed: { queueName: string; error: string }[];
}

export const listConnectionSchedulersQuerySchema = z.object({
  /** substring match on scheduler key, job name or queue name */
  q: z.string().max(200).optional(),
  /** only schedulers whose next run falls within this many ms from now */
  withinMs: z.coerce.number().int().min(0).optional(),
  /** hard cap on rows returned across all queues */
  limit: z.coerce.number().int().min(1).max(1000).default(500),
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

/**
 * Pausing is the action most often asked about after the fact ("who paused
 * billing at 3am, and why?"). The reason is free text, recorded in the audit
 * row's detail, never in Redis: BullMQ's paused flag has no room for it and the
 * audit log is where the question gets asked.
 */
export const pauseQueueSchema = z.object({
  reason: z.string().trim().max(500).optional(),
});
export type PauseQueueInput = z.infer<typeof pauseQueueSchema>;

// ---------------------------------------------------------------------------
// Bulk actions on jobs (retry / remove / promote)
//
// Between "one job" and "all 1,000 in a state" there was nothing, and the real
// case is the one in the middle: errors come clustered (one tenant's webhook
// returning 410), the server-side search finds exactly those 50 and the operator
// wants to act on them.
//
// Two decisions that shape the contract:
//
//  1. PER-CALL CAP (`BULK_JOB_LIMIT`). Without a cap someone pastes 100 thousand
//     ids and locks up Redis — that goes against the performance contract. The
//     limit is validated in zod, so the refusal is a 400 with an explanatory
//     message, not a timeout.
//  2. PARTIAL RESULT IS THE RULE. An id may have been pruned, be in another state
//     or fail inside BullMQ's atomic script. Aborting on the first error would
//     hide the 47 that worked, so the response is 200 with `{ ok, failed }` and
//     the operator sees exactly which 3 of the 50 did not go through.
// ---------------------------------------------------------------------------

/** Cap of ids per bulk call. See the comment above. */
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
  /** short, human-readable reason ("job_not_found", "cannot_retry_job_in_state_active") */
  reason: string;
}

export interface BulkJobActionResult {
  action: BulkJobAction;
  /** ids the action was applied to */
  ok: string[];
  /** ids that did not go through, with the why — never silenced */
  failed: BulkJobFailure[];
  /** how many ids were requested (ok.length + failed.length) */
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
// Attention thresholds
// ---------------------------------------------------------------------------

/**
 * When the Overview flags a queue as needing attention.
 *
 * These are NOT alerts. An alert is a persisted, scoped rule that notifies a
 * channel; these two numbers only decide whether a queue gets a card at the top
 * of the Overview. They exist because the hard-coded rules lied on real
 * workloads: a queue that always sits at 5k waiting is healthy, and a queue that
 * never passes 10 is broken at 200 — the same constant cannot serve both.
 *
 * Global on purpose. Per-connection thresholds are the obvious next step, but
 * one pair of numbers already removes the false positives people actually hit,
 * and it needs no migration.
 */
export const attentionThresholdsSchema = z.object({
  /**
   * Waiting (+ prioritized) jobs above which a queue is flagged, regardless of
   * whether a worker is draining it. The existing "backlog, no worker" rule is
   * separate and still fires at any depth: this one catches the queue that HAS a
   * worker and is losing to the producer anyway.
   *
   * 0 disables the rule, which is why the minimum is 0 and not 1.
   */
  waitingAbove: z.number().int().min(0).max(10_000_000).default(0),
  /**
   * Failed jobs in the list above which a queue is flagged. Distinct from the
   * `failing` reason, which reads the rate window: this one is the pile that is
   * already there and nobody cleaned up.
   */
  failedAbove: z.number().int().min(0).max(10_000_000).default(0),
});
export type AttentionThresholds = z.infer<typeof attentionThresholdsSchema>;

/** Both rules off: the Overview behaves exactly as it did before they existed. */
export const DEFAULT_ATTENTION_THRESHOLDS: AttentionThresholds = { waitingAbove: 0, failedAbove: 0 };

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
  /** kept for rows written before users became disable-only; no route emits it any more */
  "user.delete",
  "user.disable",
  "user.enable",
  "alert.create",
  "alert.update",
  "alert.delete",
  "license.set",
  "license.remove",
  "sso.provider_create",
  "sso.provider_update",
  "sso.provider_delete",
  "attention.thresholds_update",
  // auth
  "auth.login",
  "auth.login_failed",
  "auth.logout",
  "auth.sso_login",
  /**
   * The IdP authenticated somebody Bullpane has no user row for. Not a failure
   * of the IdP and not an attack: it is the expected outcome of the
   * pre-provisioned model, and the admin needs to see it to know who to invite.
   */
  "auth.sso_denied",
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
  "user.disable": "disabled a user",
  "user.enable": "re-enabled a user",
  "alert.create": "created an alert",
  "alert.update": "edited an alert",
  "alert.delete": "deleted an alert",
  "license.set": "applied a license key",
  "license.remove": "removed the license key",
  "sso.provider_create": "added an SSO provider",
  "sso.provider_update": "edited an SSO provider",
  "sso.provider_delete": "deleted an SSO provider",
  "attention.thresholds_update": "changed the attention thresholds",
  "auth.login": "signed in",
  "auth.login_failed": "failed to sign in",
  "auth.logout": "signed out",
  "auth.sso_login": "signed in with SSO",
  "auth.sso_denied": "was refused by SSO (no account)",
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
  // Removing 50 jobs at once destroys more data than removing one; it is here
  // for the same reason as `job.remove`.
  "job.bulk_remove",
  "connection.delete",
  "user.create",
  "user.update",
  "user.delete",
  "license.set",
  "license.remove",
  "auth.login_failed",
  // Changing who the IdP is changes who can get in, which is the same stake as
  // editing a user.
  "sso.provider_create",
  "sso.provider_update",
  "sso.provider_delete",
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
// Job tree (parent/child of ONE flow instance) — free edition
// ---------------------------------------------------------------------------

/**
 * A single job inside a flow tree.
 *
 * This is the job-level view, not the queue-level one above: nodes are real jobs
 * with real ids and states, which is what you need to answer "which child is my
 * parent stuck on". `childrenTruncated` marks a node whose children were cut by
 * the walk budget, so the UI never implies a tree is complete when it is not.
 */
export interface JobTreeNode {
  /** `${queueKey}:${id}` — unique across queues, which plain `id` is not */
  key: string;
  id: string;
  queueName: string;
  queueKey: string;
  name: string;
  state: JobState | "unknown";
  timestamp: number;
  finishedOn: number | null;
  attemptsMade: number;
  failedReason: string | null;
  progress: number | string | Record<string, unknown> | null;
  /** key of the parent node; null on the root */
  parentKey: string | null;
  /** counts straight off the parent's own sets — authoritative even when children are truncated */
  dependencies: { processed: number; unprocessed: number } | null;
  /** this node has children the walk did not expand (budget hit) */
  childrenTruncated: boolean;
  /** the job hash was gone (removed / cleaned) but a sibling set still referenced it */
  missing: boolean;
}

export interface JobTree {
  connectionId: string;
  /** key of the node the walk started from, after climbing to the root */
  rootKey: string;
  /** key of the job the user asked about — highlighted in the UI */
  focusKey: string;
  nodes: JobTreeNode[];
  /** the walk stopped at `maxNodes` and the tree shown is partial */
  truncated: boolean;
  /** how many jobs were actually read from Redis */
  visited: number;
  /** how far up the walk climbed from the focused job to reach the root */
  climbedLevels: number;
}

export const jobTreeQuerySchema = z.object({
  /** hard cap on jobs read; the walk is breadth-first so the cap keeps the top of the tree */
  maxNodes: z.coerce.number().int().min(1).max(500).default(200),
  /** climb to the root parent before expanding, so a child link shows the whole flow */
  fromRoot: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),
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
