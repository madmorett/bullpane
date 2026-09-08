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
   * BULLPANE_ALLOW_PASSWORD_LOGIN=true overrides the admin's "require SSO"
   * toggle and lets EVERY account sign in with a password again.
   *
   * This exists because the failure mode it prevents is unrecoverable: on a
   * self-hosted install there is no vendor who can log in and fix a misconfigured
   * IdP. Without an env-level way back in, one wrong issuer URL locks the
   * customer out of their own dashboard permanently. Even with the toggle on,
   * ADMIN accounts keep password access by default (see SsoLoginOptions
   * .passwordEscapeHatch); this flag widens that to everyone, which is why it is
   * an env var an operator must set on the box and not a checkbox in the UI.
   */
  allowPasswordLogin: boolean;
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
// Pricing is a section on the home page, not a route: /pricing and /pro both 404.
export const DEFAULT_CHECKOUT_URL = "https://bullpane.com/#pricing";
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

  /**
   * Not required to boot. The free edition has no login, so a first run must
   * not die asking for a secret that signs cookies nobody will ever get —
   * "start the container and open it" is the whole promise.
   *
   * It cannot be demanded lazily either: the licence may live in MySQL, which
   * is not read yet at config time, so the edition is unknown here. A generated
   * secret is therefore the default, with a warning that says exactly what it
   * costs (every restart logs everyone out) for the installs where it matters.
   */
  let sessionSecret = optional(env, "SESSION_SECRET");
  if (!sessionSecret) {
    sessionSecret = randomBytes(32).toString("base64url");
    warn(
      "SESSION_SECRET is not set; a random one was generated for this process. " +
        "The free edition has no login, so this is harmless — but set a fixed 32+ character secret " +
        "before unlocking Pro, or every restart will log everyone out.",
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
    allowPasswordLogin: bool(env, "BULLPANE_ALLOW_PASSWORD_LOGIN", false),
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
