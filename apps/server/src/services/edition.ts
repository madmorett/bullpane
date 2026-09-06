/**
 * Edition resolution: DEMO_MODE → pro (demo badge); else a valid license from the
 * settings table (`license_key`) or BMV_LICENSE_KEY → pro; else free.
 * The result is cached; PUT/DELETE /license invalidate it.
 */
import { type Edition, PRO_FEATURES, PRO_PRICE_USD, type ProFeature } from "@bullmq-visualizer/shared";
import { eq } from "drizzle-orm";
import type { Config } from "../config";
import type { Db } from "../db";
import { settings } from "../db/schema";
import { invalidLicense } from "../plugins/errors";
import { type LicenseVerification, verifyLicenseKey } from "../license";

export const LICENSE_SETTING_KEY = "license_key";

function features(enabled: boolean): Record<ProFeature, boolean> {
  return Object.fromEntries(PRO_FEATURES.map((f) => [f, enabled])) as Record<ProFeature, boolean>;
}

export function buildEdition(
  config: Pick<Config, "demoMode" | "checkoutUrl">,
  verification: LicenseVerification | null,
): Edition {
  const license: Edition["license"] = verification?.payload
    ? {
        licensee: verification.payload.licensee,
        email: verification.payload.email,
        issuedAt: verification.payload.issuedAt,
        expiresAt: verification.payload.expiresAt,
        valid: verification.valid,
      }
    : null;
  const pro = config.demoMode || verification?.valid === true;
  return {
    tier: pro ? "pro" : "free",
    demo: config.demoMode,
    features: features(pro),
    license,
    priceUsd: PRO_PRICE_USD,
    checkoutUrl: config.checkoutUrl,
  };
}

export interface EditionLogger {
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
}

export class EditionService {
  private cached: Edition | null = null;

  constructor(
    private readonly config: Config,
    private readonly db: Db,
    private readonly log: EditionLogger,
  ) {}

  /** Synchronous read of the cached edition. Call `load()` once at boot. */
  getEdition(): Edition {
    if (!this.cached) {
      // Not loaded yet (should not happen after boot): resolve from env only.
      this.cached = buildEdition(this.config, this.verify(this.config.licenseKey));
    }
    return this.cached;
  }

  invalidate(): void {
    this.cached = null;
  }

  async load(): Promise<Edition> {
    const stored = await this.readStoredKey();
    const key = stored ?? this.config.licenseKey;
    const verification = this.verify(key);
    if (verification && !verification.valid) {
      this.log.warn({ reason: verification.reason, source: stored ? "settings" : "env" }, "license key rejected");
    }
    this.cached = buildEdition(this.config, verification);
    return this.cached;
  }

  /** Validate + persist a key. Throws 400 invalid_license. */
  async setLicenseKey(key: string): Promise<Edition> {
    const verification = this.verify(key);
    if (!verification || !verification.valid) {
      throw invalidLicense(verification?.reason ?? "empty key");
    }
    await this.db
      .insert(settings)
      .values({ key: LICENSE_SETTING_KEY, value: key.trim() })
      .onDuplicateKeyUpdate({ set: { value: key.trim() } });
    this.invalidate();
    this.log.info({ licensee: verification.payload.licensee }, "license installed");
    return this.load();
  }

  async clearLicenseKey(): Promise<Edition> {
    await this.db.delete(settings).where(eq(settings.key, LICENSE_SETTING_KEY));
    this.invalidate();
    return this.load();
  }

  private verify(key: string | null | undefined): LicenseVerification | null {
    if (!key) return null;
    return verifyLicenseKey(key, { publicKeyB64: this.config.licensePublicKeyB64 });
  }

  private async readStoredKey(): Promise<string | null> {
    const rows = await this.db.select().from(settings).where(eq(settings.key, LICENSE_SETTING_KEY)).limit(1);
    const value = rows[0]?.value?.trim();
    return value ? value : null;
  }
}
