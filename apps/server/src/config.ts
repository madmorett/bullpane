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
  /** BMV_LICENSE_KEY, null when empty */
  licenseKey: string | null;
  checkoutUrl: string;
  demoMode: boolean;
  /**
   * BMV_READ_ONLY=true blocks every mutating route (job/queue actions, connection,
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
  jobPreviewBytes: number;
  /** absolute path to the built web UI */
  webDist: string;
  /** LICENSE_PUBLIC_KEY_B64 override (DER/SPKI, base64). null = compiled-in key */
  licensePublicKeyB64: string | null;
  logLevel: string;
}

export const DEFAULT_DATABASE_URL = "mysql://bmv:bmv@localhost:3306/bmv";
export const DEFAULT_CHECKOUT_URL = "https://bullmq-visualizer.dev/pro";

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

export function loadConfig(env: NodeJS.ProcessEnv = process.env, opts: LoadConfigOptions = {}): Config {
  const warn = opts.warn ?? ((m: string) => console.warn(m));
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
    licenseKey: optional(env, "BMV_LICENSE_KEY"),
    checkoutUrl: str(env, "BMV_CHECKOUT_URL", DEFAULT_CHECKOUT_URL),
    demoMode,
    readOnly: bool(env, "BMV_READ_ONLY", false),
    demoRedisUrl: str(env, "DEMO_REDIS_URL", "redis://localhost:6379"),
    demoAdminEmail: str(env, "DEMO_ADMIN_EMAIL", "demo@bullmq-visualizer.dev"),
    demoAdminPassword: str(env, "DEMO_ADMIN_PASSWORD", "demo1234"),
    queueDiscoveryTtl: int(env, "BMV_QUEUE_DISCOVERY_TTL", 30, 1),
    alertsInterval: int(env, "BMV_ALERTS_INTERVAL", 15, 1),
    jobPreviewBytes: int(env, "BMV_JOB_PREVIEW_BYTES", 2048, 64),
    webDist: path.resolve(SERVER_ROOT, str(env, "WEB_DIST", "../web/dist")),
    licensePublicKeyB64: optional(env, "LICENSE_PUBLIC_KEY_B64"),
    logLevel: str(env, "LOG_LEVEL", "info"),
  };
}

export function isHttps(publicUrl: string): boolean {
  return /^https:\/\//i.test(publicUrl);
}
