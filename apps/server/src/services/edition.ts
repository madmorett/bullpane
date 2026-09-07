/**
 * Edition resolution.
 *
 *   DEMO_MODE=true                     → pro, "demo" badge
 *   offline token (payload.signature)  → verified locally, perpetual or dated
 *   store key (BULLPANE-…)             → activated once through the license API,
 *                                        which answers with a 7-day signed lease;
 *                                        refreshed every BMV_LICENSE_REFRESH_HOURS
 *   nothing                            → free
 *
 * The lease is the whole trick: the server verifies it with the same Ed25519
 * code as an offline key, so losing the internet for a few days changes
 * nothing, and a cancelled subscription is known within a day. A refresh that
 * gets a definitive "no" (revoked, expired, used elsewhere) locks Pro at once;
 * a refresh that gets no answer keeps the lease and shows "grace".
 *
 * Persistence: `settings.license_key` holds what the admin pasted (or
 * BMV_LICENSE_KEY on first boot), `settings.license_online` the activation
 * id, the current lease and the last check. Both are removed together.
 */
import os from "node:os";
import {
  type Edition,
  LICENSE_API_DEFINITIVE_CODES,
  type LicenseInfo,
  type LicenseStatus,
  PRO_FEATURES,
  PRO_PRICING,
  type ProFeature,
} from "@bullmq-visualizer/shared";
import type { Config } from "../config";
import { errorMessage, HttpError, invalidLicense, licenseAlreadyActivated, licenseServerUnavailable } from "../plugins/errors";
import { isOfflineToken, type LicenseVerification, verifyLicenseKey } from "../license";
import { LicenseApiFailure, type LicenseClient } from "./license-client";
import type { SettingsStore } from "./settings-store";

export const LICENSE_SETTING_KEY = "license_key";
export const LICENSE_ONLINE_SETTING_KEY = "license_online";

/** Result of the last contact with the license API. */
export interface OnlineCheckError {
  code: string;
  message: string;
  /** true = the store answered "no" about this key; false = it could not be asked */
  definitive: boolean;
}

export interface OnlineState {
  activationId: string;
  lease: string;
  /** unix ms of the last attempt, successful or not */
  lastCheckedAt: number | null;
  lastCheckError: OnlineCheckError | null;
}

export type ResolvedLicense =
  | { source: "offline"; token: string; verification: LicenseVerification }
  | { source: "online"; key: string; state: OnlineState; verification: LicenseVerification }
  | null;

function features(enabled: boolean): Record<ProFeature, boolean> {
  return Object.fromEntries(PRO_FEATURES.map((f) => [f, enabled])) as Record<ProFeature, boolean>;
}

function statusFromVerification(v: LicenseVerification): LicenseStatus {
  if (v.valid) return "active";
  return /expired/i.test(v.reason) ? "expired" : "invalid";
}

export function licenseInfo(resolved: ResolvedLicense): LicenseInfo | null {
  if (!resolved) return null;
  const payload = resolved.verification.payload;
  if (!payload) return null;
  const base = {
    licensee: payload.licensee,
    email: payload.email,
    issuedAt: payload.issuedAt,
  };
  if (resolved.source === "offline") {
    return {
      ...base,
      expiresAt: payload.expiresAt,
      valid: resolved.verification.valid,
      source: "offline",
      billing: payload.billing ?? "perpetual",
      status: statusFromVerification(resolved.verification),
      leaseExpiresAt: null,
      lastCheckedAt: null,
      lastCheckError: null,
      activationId: null,
    };
  }
  const { state, verification } = resolved;
  const err = state.lastCheckError;
  let status: LicenseStatus;
  if (err?.definitive) status = err.code === "license_expired" ? "expired" : "invalid";
  else if (!verification.valid) status = statusFromVerification(verification);
  else status = err ? "grace" : "active";
  return {
    ...base,
    expiresAt: payload.subscriptionExpiresAt ?? null,
    valid: status === "active" || status === "grace",
    source: "online",
    billing: payload.billing ?? "subscription",
    status,
    leaseExpiresAt: payload.expiresAt,
    lastCheckedAt: state.lastCheckedAt,
    lastCheckError: err?.message ?? null,
    activationId: state.activationId,
  };
}

export function buildEdition(config: Pick<Config, "demoMode" | "checkoutUrl">, resolved: ResolvedLicense): Edition {
  const license = licenseInfo(resolved);
  const pro = config.demoMode || license?.valid === true;
  return {
    tier: pro ? "pro" : "free",
    demo: config.demoMode,
    features: features(pro),
    license,
    pricing: { ...PRO_PRICING },
    checkoutUrl: config.checkoutUrl,
  };
}

export interface EditionLogger {
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
}

export interface EditionServiceOptions {
  config: Config;
  settings: SettingsStore;
  log: EditionLogger;
  client: LicenseClient;
  /** shown to the customer in the store portal; defaults to hostname + PUBLIC_URL */
  instanceLabel?: string;
  version?: string;
  now?: () => number;
}

/** A refresh right after boot is skipped when the last one is this recent. */
const BOOT_REFRESH_MIN_AGE_MS = 60 * 60 * 1000;
const BOOT_REFRESH_DELAY_MS = 5_000;

export class EditionService {
  private readonly config: Config;
  private readonly settings: SettingsStore;
  private readonly log: EditionLogger;
  private readonly client: LicenseClient;
  private readonly instanceLabel: string;
  private readonly version: string | undefined;
  private readonly now: () => number;

  private resolved: ResolvedLicense = null;
  /** store key seen (env) with no activation yet; activated on the next tick */
  private pendingKey: string | null = null;
  private cached: Edition | null = null;
  /** unix ms when the cached edition must be rebuilt (a lease or key expiry) */
  private cachedUntil = Number.POSITIVE_INFINITY;
  private timer: NodeJS.Timeout | null = null;
  private bootTimer: NodeJS.Timeout | null = null;
  private inflight: Promise<void> | null = null;

  constructor(opts: EditionServiceOptions) {
    this.config = opts.config;
    this.settings = opts.settings;
    this.log = opts.log;
    this.client = opts.client;
    this.instanceLabel = (opts.instanceLabel ?? defaultInstanceLabel(opts.config.publicUrl)).slice(0, 120);
    this.version = opts.version;
    this.now = opts.now ?? (() => Date.now());
  }

  /** Synchronous read of the cached edition. Call `load()` once at boot. */
  getEdition(): Edition {
    if (!this.cached || this.now() >= this.cachedUntil) this.rebuild();
    return this.cached as Edition;
  }

  /** @deprecated kept for callers that used to poke the cache; load() and refresh() rebuild on their own */
  invalidate(): void {
    this.cached = null;
  }

  async load(): Promise<Edition> {
    const stored = await this.settings.get(LICENSE_SETTING_KEY);
    const key = (stored ?? this.config.licenseKey)?.trim() || null;
    const from = stored ? "settings" : "env";
    this.pendingKey = null;

    if (!key) {
      this.resolved = null;
    } else if (isOfflineToken(key)) {
      const verification = this.verify(key);
      if (!verification.valid) this.log.warn({ reason: verification.reason, source: from }, "license key rejected");
      this.resolved = { source: "offline", token: key, verification };
    } else {
      const state = await this.readOnlineState();
      if (state) {
        this.resolved = { source: "online", key, state, verification: this.verify(state.lease) };
      } else {
        this.resolved = null;
        this.pendingKey = key;
        this.log.info({ source: from }, "license key found without an activation; contacting the license server after boot");
      }
    }
    this.rebuild();
    return this.cached as Edition;
  }

  /**
   * Validate + persist a key.
   *  400 invalid_license            – bad signature / unknown / revoked / expired key
   *  409 license_already_activated  – store key in use on another installation
   *  502 license_server_unavailable – could not reach api.bullpane.com
   */
  async setLicenseKey(raw: string): Promise<Edition> {
    const key = raw.trim();
    if (!key) throw invalidLicense("empty key");

    if (isOfflineToken(key)) {
      const verification = this.verify(key);
      if (!verification.valid) throw invalidLicense(verification.reason);
      await this.releaseActivation();
      await this.settings.set(LICENSE_SETTING_KEY, key);
      await this.settings.delete(LICENSE_ONLINE_SETTING_KEY);
      this.log.info({ licensee: verification.payload.licensee }, "offline license installed");
      return this.load();
    }

    const current = this.resolved?.source === "online" ? this.resolved : null;
    const now = this.now();
    let lease: string;
    let activationId: string;
    try {
      if (current && current.key === key) {
        // Same key again: the install already holds an activation, refreshing is
        // free. Only when the store no longer knows that activation (deactivated
        // from the portal) do we activate afresh.
        try {
          lease = await this.client.refresh({ key, activationId: current.state.activationId });
          activationId = this.acceptLease(lease, current.state.activationId);
        } catch (err) {
          if (!(err instanceof LicenseApiFailure) || !["license_activation_mismatch", "license_not_found"].includes(err.code)) throw err;
          lease = await this.client.activate({ key, instance: { label: this.instanceLabel, version: this.version } });
          activationId = this.acceptLease(lease, null);
        }
      } else {
        lease = await this.client.activate({ key, instance: { label: this.instanceLabel, version: this.version } });
        activationId = this.acceptLease(lease, null);
        // Activated the new key first so a failure leaves the old one in place.
        await this.releaseActivation();
      }
    } catch (err) {
      throw toHttpError(err);
    }
    await this.settings.set(LICENSE_SETTING_KEY, key);
    await this.writeOnlineState({ activationId, lease, lastCheckedAt: now, lastCheckError: null });
    this.log.info({ activationId }, "subscription license activated");
    return this.load();
  }

  /** Free the activation (best effort) and go back to the free edition. */
  async clearLicenseKey(): Promise<Edition> {
    await this.releaseActivation();
    await this.settings.delete(LICENSE_SETTING_KEY);
    await this.settings.delete(LICENSE_ONLINE_SETTING_KEY);
    return this.load();
  }

  /**
   * Contact the license API now: activate a pending env key, or renew the
   * lease. Never throws; the outcome lands in `Edition.license.status`.
   */
  async refresh(): Promise<Edition> {
    if (!this.inflight) {
      this.inflight = this.doRefresh().finally(() => {
        this.inflight = null;
      });
    }
    await this.inflight;
    return this.getEdition();
  }

  /** Periodic refresh. Idempotent. */
  start(): void {
    if (this.timer) return;
    const intervalMs = this.config.licenseRefreshHours * 60 * 60 * 1000;
    this.timer = setInterval(() => void this.tick(false), intervalMs);
    this.timer.unref?.();
    this.bootTimer = setTimeout(() => void this.tick(true), BOOT_REFRESH_DELAY_MS);
    this.bootTimer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.bootTimer) clearTimeout(this.bootTimer);
    this.timer = null;
    this.bootTimer = null;
  }

  /** true when the next tick would talk to the license API */
  needsRefresh(boot: boolean): boolean {
    if (this.pendingKey) return true;
    if (this.resolved?.source !== "online") return false;
    if (!boot) return true;
    const { lastCheckedAt, lastCheckError } = this.resolved.state;
    // Restart storms (deploys, crash loops) must not hammer the API: a clean,
    // recent check is good enough for another hour.
    return lastCheckError !== null || lastCheckedAt === null || this.now() - lastCheckedAt >= BOOT_REFRESH_MIN_AGE_MS;
  }

  private async tick(boot: boolean): Promise<void> {
    try {
      if (!this.needsRefresh(boot)) return;
      await this.refresh();
    } catch (err) {
      this.log.warn({ err: errorMessage(err) }, "license refresh failed");
    }
  }

  private async doRefresh(): Promise<void> {
    if (this.pendingKey) {
      await this.activatePending(this.pendingKey);
      return;
    }
    if (this.resolved?.source !== "online") return;
    const { key, state } = this.resolved;
    const now = this.now();
    try {
      const lease = await this.client.refresh({ key, activationId: state.activationId });
      const activationId = this.acceptLease(lease, state.activationId);
      await this.writeOnlineState({ activationId, lease, lastCheckedAt: now, lastCheckError: null });
      this.log.info({ activationId }, "license lease renewed");
    } catch (err) {
      const failure = toCheckError(err);
      await this.writeOnlineState({ ...state, lastCheckedAt: now, lastCheckError: failure });
      if (failure.definitive) {
        this.log.warn({ code: failure.code, message: failure.message }, "license rejected by the store; Pro features locked");
      } else {
        const until = this.resolved.verification.payload?.expiresAt;
        this.log.warn(
          { code: failure.code, message: failure.message, leaseExpiresAt: until ? new Date(until).toISOString() : null },
          "license server unreachable; running on the current lease",
        );
      }
    }
    await this.load();
  }

  private async activatePending(key: string): Promise<void> {
    try {
      const lease = await this.client.activate({ key, instance: { label: this.instanceLabel, version: this.version } });
      const activationId = this.acceptLease(lease, null);
      await this.settings.set(LICENSE_SETTING_KEY, key);
      await this.writeOnlineState({ activationId, lease, lastCheckedAt: this.now(), lastCheckError: null });
      this.log.info({ activationId }, "subscription license activated from BMV_LICENSE_KEY");
      await this.load();
    } catch (err) {
      const failure = toCheckError(err);
      this.log.warn(
        { code: failure.code, message: failure.message },
        failure.definitive ? "BMV_LICENSE_KEY rejected by the store; running the free edition" : "could not activate BMV_LICENSE_KEY yet; will retry",
      );
    }
  }

  /** Verify a lease from the API. Throws 502 when it cannot be trusted. */
  private acceptLease(lease: string, expectedActivationId: string | null): string {
    const verification = this.verify(lease);
    if (!verification.valid) throw licenseServerUnavailable(`the lease it sent does not verify (${verification.reason})`);
    const activationId = verification.payload.activationId;
    if (!activationId) throw licenseServerUnavailable("the lease it sent has no activation id");
    if (expectedActivationId && activationId !== expectedActivationId) {
      throw licenseServerUnavailable("the lease it sent belongs to another activation");
    }
    return activationId;
  }

  /** Tell the store this install no longer uses its activation. Best effort. */
  private async releaseActivation(): Promise<void> {
    if (this.resolved?.source !== "online") return;
    const { key, state } = this.resolved;
    try {
      await this.client.deactivate({ key, activationId: state.activationId });
      this.log.info({ activationId: state.activationId }, "license activation released");
    } catch (err) {
      this.log.warn({ err: errorMessage(err) }, "could not release the license activation; free it from the customer portal if needed");
    }
  }

  private rebuild(): void {
    const now = this.now();
    if (this.resolved) {
      // Re-verify so a lease or key that expired while cached flips to free.
      const token = this.resolved.source === "offline" ? this.resolved.token : this.resolved.state.lease;
      this.resolved = { ...this.resolved, verification: this.verify(token) };
    }
    this.cached = buildEdition(this.config, this.resolved);
    const expiresAt = this.resolved?.verification.payload?.expiresAt ?? null;
    this.cachedUntil = expiresAt !== null && expiresAt > now ? expiresAt : Number.POSITIVE_INFINITY;
  }

  private verify(token: string): LicenseVerification {
    return verifyLicenseKey(token, { publicKeyB64: this.config.licensePublicKeyB64, now: this.now() });
  }

  private async readOnlineState(): Promise<OnlineState | null> {
    const raw = await this.settings.get(LICENSE_ONLINE_SETTING_KEY);
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw) as Partial<OnlineState>;
      if (typeof parsed.activationId !== "string" || typeof parsed.lease !== "string") return null;
      return {
        activationId: parsed.activationId,
        lease: parsed.lease,
        lastCheckedAt: typeof parsed.lastCheckedAt === "number" ? parsed.lastCheckedAt : null,
        lastCheckError: parsed.lastCheckError ?? null,
      };
    } catch {
      return null;
    }
  }

  private async writeOnlineState(state: OnlineState): Promise<void> {
    await this.settings.set(LICENSE_ONLINE_SETTING_KEY, JSON.stringify(state));
  }
}

function defaultInstanceLabel(publicUrl: string): string {
  let host = "";
  try {
    host = new URL(publicUrl).host;
  } catch {
    host = publicUrl;
  }
  const name = os.hostname();
  return host && host !== name ? `${name} · ${host}` : name;
}

function toCheckError(err: unknown): OnlineCheckError {
  if (err instanceof LicenseApiFailure) {
    return {
      code: err.code,
      message: err.message,
      definitive: (LICENSE_API_DEFINITIVE_CODES as readonly string[]).includes(err.code),
    };
  }
  if (err instanceof HttpError) return { code: err.error, message: err.message, definitive: false };
  return { code: "unknown", message: errorMessage(err), definitive: false };
}

function toHttpError(err: unknown): HttpError {
  if (err instanceof HttpError) return err;
  if (err instanceof LicenseApiFailure) {
    switch (err.code) {
      case "license_activation_limit":
        return licenseAlreadyActivated(err.message);
      case "license_not_found":
      case "license_revoked":
      case "license_expired":
      case "license_activation_mismatch":
      case "validation":
        return invalidLicense(err.message);
      default:
        return licenseServerUnavailable(err.message);
    }
  }
  return licenseServerUnavailable(errorMessage(err));
}
