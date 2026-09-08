/**
 * SSO providers + the "require SSO" setting.
 *
 * Two rules shape this whole file:
 *
 * 1. THE SECRET NEVER COMES BACK OUT through the API. `toDto` strips it and
 *    reports `hasSecret` instead, the same way connection URLs are redacted.
 *    Only `clientSecretFor()` decrypts, and only the login flow calls it.
 *
 * 2. NO JUST-IN-TIME PROVISIONING. `resolveUser` looks the asserted email up in
 *    `users` and returns null when there is no row. The IdP says who somebody
 *    is; it does not get to say that they have an account here, nor what role.
 */
import {
  DEFAULT_SAML_EMAIL_ATTRIBUTE,
  type CreateSsoProviderInput,
  type SsoKind,
  type SsoLoginOption,
  type SsoLoginOptions,
  type SsoProvider,
  type UpdateSsoProviderInput,
  type User,
} from "@bullpane/shared";
import { asc, eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { decryptSecret, encryptSecret, SecretDecryptError } from "../auth/sso/crypto";
import { toUserDto } from "../auth/sessions";
import type { Config } from "../config";
import type { Db } from "../db";
import { ssoProviders, users, type SsoProviderRow } from "../db/schema";
import { conflict, notFound, validation } from "../plugins/errors";
import type { SettingsStore } from "./settings-store";

/** settings key. Not an env var: the admin flips it in the UI. */
export const REQUIRE_SSO_KEY = "sso.require_sso";

/** Fields that are write-only and must never be echoed back. */
const WRITE_ONLY = new Set(["clientSecret"]);

export function stripSecrets(config: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(config).filter(([k]) => !WRITE_ONLY.has(k)));
}

export class SsoService {
  constructor(
    private readonly db: Db,
    private readonly config: Pick<Config, "publicUrl" | "sessionSecret" | "allowPasswordLogin">,
    private readonly settings: SettingsStore,
  ) {}

  /** Where the admin must point the IdP. Derived from PUBLIC_URL so it is always right. */
  callbackUrl(providerId: string): string {
    return `${this.config.publicUrl}/api/auth/sso/${providerId}/callback`;
  }

  /** SAML SP entity id. Stable per install, derived rather than stored. */
  entityId(): string {
    return `${this.config.publicUrl}/api/auth/sso/metadata`;
  }

  private toDto(row: SsoProviderRow): SsoProvider {
    return {
      id: row.id,
      kind: row.kind,
      name: row.name,
      enabled: row.enabled,
      config: stripSecrets(row.config),
      hasSecret: row.secretEnc !== null && row.secretEnc !== "",
      callbackUrl: this.callbackUrl(row.id),
      entityId: row.kind === "saml" ? this.entityId() : null,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  async list(): Promise<SsoProvider[]> {
    const rows = await this.db.select().from(ssoProviders).orderBy(asc(ssoProviders.createdAt));
    return rows.map((r) => this.toDto(r));
  }

  async getRow(id: string): Promise<SsoProviderRow> {
    const rows = await this.db.select().from(ssoProviders).where(eq(ssoProviders.id, id)).limit(1);
    const row = rows[0];
    if (!row) throw notFound("SSO provider");
    return row;
  }

  async get(id: string): Promise<SsoProvider> {
    return this.toDto(await this.getRow(id));
  }

  async create(input: CreateSsoProviderInput): Promise<SsoProvider> {
    const id = nanoid();
    const now = new Date();
    const { config, secretEnc } = this.splitSecret(input.kind, input.config as Record<string, unknown>);
    await this.db.insert(ssoProviders).values({
      id,
      kind: input.kind,
      name: input.name,
      enabled: input.enabled ?? true,
      config,
      secretEnc,
      createdAt: now,
      updatedAt: now,
    });
    return this.get(id);
  }

  async update(id: string, input: UpdateSsoProviderInput): Promise<SsoProvider> {
    const row = await this.getRow(id);
    const patch: Partial<typeof ssoProviders.$inferInsert> = {};
    if (input.name !== undefined) patch.name = input.name;
    if (input.enabled !== undefined) patch.enabled = input.enabled;
    if (input.config !== undefined) {
      /**
       * A PATCH merges into the stored config, so the admin can fix the issuer
       * without re-typing the client secret. An absent `clientSecret` means
       * "leave it alone"; an empty string is refused rather than silently
       * clearing a working secret.
       */
      const incoming = input.config as Record<string, unknown>;
      const merged = { ...stripSecrets(row.config), ...stripSecrets(incoming) };
      const { config, secretEnc } = this.splitSecret(row.kind, { ...merged, ...(incoming["clientSecret"] !== undefined ? { clientSecret: incoming["clientSecret"] } : {}) });
      patch.config = config;
      if (secretEnc !== null) patch.secretEnc = secretEnc;
    }
    if (Object.keys(patch).length > 0) {
      patch.updatedAt = new Date();
      await this.db.update(ssoProviders).set(patch).where(eq(ssoProviders.id, id));
    }
    return this.get(id);
  }

  async remove(id: string): Promise<void> {
    const row = await this.getRow(id);
    /**
     * Deleting the last enabled provider while "require SSO" is on would lock
     * everybody out except through the escape hatch. Refuse it and make the
     * admin turn the toggle off first — an explicit two-step beats a support
     * ticket from somebody who cannot get in.
     */
    if (row.enabled && (await this.requireSso())) {
      const others = (await this.db.select().from(ssoProviders).where(eq(ssoProviders.enabled, true))).filter((r) => r.id !== id);
      if (others.length === 0) {
        throw conflict('This is the only enabled SSO provider and "require SSO" is on. Turn that off before deleting it.');
      }
    }
    await this.db.delete(ssoProviders).where(eq(ssoProviders.id, id));
  }

  /**
   * Pulls the write-only secret out of a config object, encrypts it, and
   * returns the config that is safe to store as JSON.
   */
  private splitSecret(kind: SsoKind, config: Record<string, unknown>): { config: Record<string, unknown>; secretEnc: string | null } {
    const rest = stripSecrets(config);
    if (kind === "saml") {
      // SAML verifies a signature with a public cert; there is nothing secret.
      return { config: rest, secretEnc: null };
    }
    const raw = config["clientSecret"];
    if (raw === undefined) return { config: rest, secretEnc: null };
    if (typeof raw !== "string" || raw.trim() === "") {
      throw validation("clientSecret cannot be empty. Omit the field to keep the current secret.");
    }
    return { config: rest, secretEnc: encryptSecret(raw, this.config.sessionSecret) };
  }

  /** Decrypts the OIDC client secret for the token exchange. Login path only. */
  clientSecretFor(row: SsoProviderRow): string {
    if (!row.secretEnc) {
      throw validation(`SSO provider "${row.name}" has no client secret configured.`);
    }
    try {
      return decryptSecret(row.secretEnc, this.config.sessionSecret);
    } catch (err) {
      if (err instanceof SecretDecryptError) throw validation(err.message);
      throw err;
    }
  }

  async requireSso(): Promise<boolean> {
    return (await this.settings.get(REQUIRE_SSO_KEY)) === "true";
  }

  async setRequireSso(value: boolean): Promise<void> {
    if (value) {
      const enabled = await this.db.select().from(ssoProviders).where(eq(ssoProviders.enabled, true));
      if (enabled.length === 0) {
        throw conflict("Add and enable an SSO provider before requiring SSO, or nobody will be able to sign in.");
      }
    }
    await this.settings.set(REQUIRE_SSO_KEY, value ? "true" : "false");
  }

  /**
   * What the unauthenticated login page is allowed to know. Deliberately
   * excludes the issuer, the client id and anything else about the customer's
   * IdP: the button label is enough to start the flow.
   */
  async loginOptions(): Promise<SsoLoginOptions> {
    const rows = await this.db.select().from(ssoProviders).where(eq(ssoProviders.enabled, true)).orderBy(asc(ssoProviders.createdAt));
    const providers: SsoLoginOption[] = rows.map((r) => ({ id: r.id, kind: r.kind, name: r.name }));
    const requireSso = providers.length > 0 && (await this.requireSso());
    return {
      providers,
      requireSso,
      passwordEscapeHatch: !requireSso ? "none" : this.config.allowPasswordLogin ? "all" : "admins",
    };
  }

  /**
   * The pre-provisioned model, enforced. Returns null when the IdP
   * authenticated somebody who has no Bullpane account — the caller turns that
   * into an `auth.sso_denied` audit row and a message telling them to ask an
   * admin, never into a new user.
   */
  async resolveUser(email: string): Promise<User | null> {
    const normalised = email.trim().toLowerCase();
    if (!normalised) return null;
    const rows = await this.db.select().from(users).where(eq(users.email, normalised)).limit(1);
    const row = rows[0];
    return row ? toUserDto(row) : null;
  }

  /** SAML attribute name the admin configured, or the common default. */
  samlEmailAttribute(config: Record<string, unknown>): string {
    const configured = config["emailAttribute"];
    return typeof configured === "string" && configured.length > 0 ? configured : DEFAULT_SAML_EMAIL_ATTRIBUTE;
  }
}
