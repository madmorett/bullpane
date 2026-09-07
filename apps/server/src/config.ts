/**
 * Typed environment loading. Every variable in /.env.example is honoured here.
 * Nothing else in the server reads process.env directly.
 */
import { randomBytes } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** apps/server (the package root), resolved from src/ or dist/ alike. */
export const SERVER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export interface Config {
  port: number;
  host: string;
  sessionSecret: string;
  publicUrl: string;
  databaseUrl: string;
  /** BULLPANE_LICENSE_KEY, null when empty. Offline token or store key, see license.ts */
  licenseKey: string | null;
  checkoutUrl: string;
  /** BULLPANE_LICENSE_API_URL: where subscription keys are activated and refreshed */
  licenseApiUrl: string;
  /** BULLPANE_LICENSE_REFRESH_HOURS: how often an online key is re-checked */
  licenseRefreshHours: number;
  demoMode: boolean;
  /**
   * BULLPANE_READ_ONLY=true blocks every mutating route (job/queue actions, connection,
   * user, folder, alert and license writes) with 423. Reads are untouched.
   * Meant for pointing the dashboard at production before you trust it.
   */
  readOnly: boolean;
  demoRedisUrl: string;
  demoAdminEmail: string;
  demoAdminPassword: string;
  /** seconds */
  queueDiscoveryTtl: number;
  /** seconds */
  alertsInterval: number;
  /**
   * BULLPANE_AUDIT_RETENTION_DAYS: how long audit rows are kept. Default 365 because
   * "one year" is what compliance questionnaires ask for. 0 disables pruning
   * (keep forever — then you own the growth).
   */
  auditRetentionDays: number;
  jobPreviewBytes: number;
  /** absolute path to the built web UI */
  webDist: string;
  /** LICENSE_PUBLIC_KEY_B64 override (DER/SPKI, base64). null = compiled-in key */
  licensePublicKeyB64: string | null;
  logLevel: string;
}

export const DEFAULT_DATABASE_URL = "mysql://bullpane:bullpane@localhost:3306/bullpane";
export const DEFAULT_CHECKOUT_URL = "https://bullpane.com/pricing";
export const DEFAULT_LICENSE_API_URL = "https://api.bullpane.com";

function str(env: NodeJS.ProcessEnv, key: string, fallback: string): string {
  const v = env[key];
  return v === undefined || v === "" ? fallback : v;
}

function optional(env: NodeJS.ProcessEnv, key: string): string | null {
  const v = env[key];
  return v === undefined || v.trim() === "" ? null : v.trim();
}

function int(env: NodeJS.ProcessEnv, key: string, fallback: number, min = 0): number {
  const raw = env[key];
  if (raw === undefined || raw === "") return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < min) {
    throw new Error(`Invalid ${key}="${raw}": expected an integer >= ${min}`);
  }
  return n;
}

function bool(env: NodeJS.ProcessEnv, key: string, fallback: boolean): boolean {
  const raw = env[key];
  if (raw === undefined || raw === "") return fallback;
  return ["1", "true", "yes", "on"].includes(raw.trim().toLowerCase());
}

export interface LoadConfigOptions {
  /** where warnings go (default console.warn) */
  warn?: (message: string) => void;
}

/**
 * Until 0.1.x the prefix was BMV_ (BullMQ Visualizer). Installs that still set
 * BMV_* keep working: each one is copied to its BULLPANE_* name unless that is
 * already set, with one warning so the operator knows to rename.
 */
export function withLegacyEnv(env: NodeJS.ProcessEnv, warn: (message: string) => void): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env };
  for (const [key, value] of Object.entries(env)) {
    if (!key.startsWith("BMV_") || value === undefined) continue;
    const renamed = `BULLPANE_${key.slice(4)}`;
    if (out[renamed] === undefined || out[renamed] === "") {
      out[renamed] = value;
      warn(`${key} is deprecated, use ${renamed}`);
    }
  }
  return out;
}

export function loadConfig(rawEnv: NodeJS.ProcessEnv = process.env, opts: LoadConfigOptions = {}): Config {
  const warn = opts.warn ?? ((m: string) => console.warn(m));
  const env = withLegacyEnv(rawEnv, warn);
  const demoMode = bool(env, "DEMO_MODE", false);

  let sessionSecret = optional(env, "SESSION_SECRET");
  if (!sessionSecret) {
    if (!demoMode) {
      throw new Error(
        "SESSION_SECRET is required (32+ random chars). Set it in .env or the environment. " +
          "Only DEMO_MODE=true may run without one.",
      );
    }
    sessionSecret = randomBytes(32).toString("base64url");
    warn(
      "!!! SESSION_SECRET is not set. DEMO_MODE generated a random one: every restart logs everyone out. " +
        "Never run like this outside the playground.",
    );
  } else if (sessionSecret.length < 32) {
    warn("SESSION_SECRET is shorter than 32 characters. Use a longer random string.");
  }

  const publicUrl = str(env, "PUBLIC_URL", "http://localhost:3000").replace(/\/+$/, "");

  return {
    port: int(env, "PORT", 3000, 1),
    host: str(env, "HOST", "0.0.0.0"),
    sessionSecret,
    publicUrl,
    databaseUrl: str(env, "DATABASE_URL", DEFAULT_DATABASE_URL),
    licenseKey: optional(env, "BULLPANE_LICENSE_KEY"),
    checkoutUrl: str(env, "BULLPANE_CHECKOUT_URL", DEFAULT_CHECKOUT_URL),
    licenseApiUrl: str(env, "BULLPANE_LICENSE_API_URL", DEFAULT_LICENSE_API_URL).replace(/\/+$/, ""),
    licenseRefreshHours: int(env, "BULLPANE_LICENSE_REFRESH_HOURS", 24, 1),
    demoMode,
    readOnly: bool(env, "BULLPANE_READ_ONLY", false),
    demoRedisUrl: str(env, "DEMO_REDIS_URL", "redis://localhost:6379"),
    demoAdminEmail: str(env, "DEMO_ADMIN_EMAIL", "demo@bullpane.com"),
    demoAdminPassword: str(env, "DEMO_ADMIN_PASSWORD", "demo1234"),
    queueDiscoveryTtl: int(env, "BULLPANE_QUEUE_DISCOVERY_TTL", 30, 1),
    alertsInterval: int(env, "BULLPANE_ALERTS_INTERVAL", 15, 1),
    auditRetentionDays: int(env, "BULLPANE_AUDIT_RETENTION_DAYS", 365, 0),
    jobPreviewBytes: int(env, "BULLPANE_JOB_PREVIEW_BYTES", 2048, 64),
    webDist: path.resolve(SERVER_ROOT, str(env, "WEB_DIST", "../web/dist")),
    licensePublicKeyB64: optional(env, "LICENSE_PUBLIC_KEY_B64"),
    logLevel: str(env, "LOG_LEVEL", "info"),
  };
}

export function isHttps(publicUrl: string): boolean {
  return /^https:\/\//i.test(publicUrl);
}
