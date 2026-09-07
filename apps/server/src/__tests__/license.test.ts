import { generateKeyPairSync } from "node:crypto";
import { PRO_PRICING, type LicensePayload } from "@bullpane/shared";
import { describe, expect, it } from "vitest";
import { isOfflineToken, type LicenseVerification, signLicense, verifyLicenseKey } from "../license";
import { buildEdition, type OnlineState, type ResolvedLicense } from "../services/edition";

function keypair() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return { privateKey, publicKeyB64: publicKey.export({ type: "spki", format: "der" }).toString("base64") };
}

const NOW = Date.UTC(2026, 0, 1);

const basePayload: LicensePayload = {
  licensee: "Acme Corp",
  email: "ops@acme.test",
  plan: "pro",
  issuedAt: NOW - 1000,
  expiresAt: null,
};

describe("license verification", () => {
  it("accepts a perpetual license signed with the matching key", () => {
    const { privateKey, publicKeyB64 } = keypair();
    const key = signLicense(basePayload, privateKey);
    const result = verifyLicenseKey(key, { publicKeyB64, now: NOW });
    expect(result.valid).toBe(true);
    expect(result.payload?.licensee).toBe("Acme Corp");
  });

  it("rejects a tampered payload", () => {
    const { privateKey, publicKeyB64 } = keypair();
    const key = signLicense(basePayload, privateKey);
    const [, sig] = key.split(".");
    const tampered = Buffer.from(JSON.stringify({ ...basePayload, licensee: "Evil Corp" })).toString("base64url");
    const result = verifyLicenseKey(`${tampered}.${sig}`, { publicKeyB64, now: NOW });
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/signature/);
  });

  it("rejects a key signed by another private key", () => {
    const { privateKey } = keypair();
    const other = keypair();
    const key = signLicense(basePayload, privateKey);
    expect(verifyLicenseKey(key, { publicKeyB64: other.publicKeyB64, now: NOW }).valid).toBe(false);
  });

  it("rejects an expired license but still exposes its payload", () => {
    const { privateKey, publicKeyB64 } = keypair();
    const key = signLicense({ ...basePayload, expiresAt: NOW - 1 }, privateKey);
    const result = verifyLicenseKey(key, { publicKeyB64, now: NOW });
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/expired/);
    expect(result.payload?.email).toBe("ops@acme.test");
  });

  it("accepts a license that expires in the future", () => {
    const { privateKey, publicKeyB64 } = keypair();
    const key = signLicense({ ...basePayload, expiresAt: NOW + 86_400_000 }, privateKey);
    expect(verifyLicenseKey(key, { publicKeyB64, now: NOW }).valid).toBe(true);
  });

  it("rejects malformed keys without throwing", () => {
    const { publicKeyB64 } = keypair();
    for (const bad of ["", "abc", "a.b.c", "not-base64.!!!", `${Buffer.from("{}").toString("base64url")}.AAAA`]) {
      const result = verifyLicenseKey(bad, { publicKeyB64, now: NOW });
      expect(result.valid).toBe(false);
    }
  });

  it("rejects a non-pro plan even when correctly signed", () => {
    const { privateKey, publicKeyB64 } = keypair();
    const key = signLicense({ ...basePayload, plan: "basic" as unknown as "pro" }, privateKey);
    expect(verifyLicenseKey(key, { publicKeyB64, now: NOW }).valid).toBe(false);
  });
});

describe("buildEdition", () => {
  const config = { demoMode: false, checkoutUrl: "https://example.test/pro" };
  const offline = (verification: LicenseVerification): ResolvedLicense => ({ source: "offline", token: "t", verification });

  it("is free without a license", () => {
    const e = buildEdition(config, null);
    expect(e.tier).toBe("free");
    expect(e.demo).toBe(false);
    expect(e.features).toEqual({ alerts: false, users: false, folders: false, flows: false, audit: false });
    expect(e.license).toBeNull();
    expect(e.pricing).toEqual(PRO_PRICING);
    expect(e.checkoutUrl).toBe("https://example.test/pro");
  });

  it("is pro with a valid offline license", () => {
    const e = buildEdition(config, offline({ valid: true, payload: basePayload, reason: null }));
    expect(e.tier).toBe("pro");
    expect(e.features).toEqual({ alerts: true, users: true, folders: true, flows: true, audit: true });
    expect(e.license).toMatchObject({
      licensee: "Acme Corp",
      email: "ops@acme.test",
      issuedAt: basePayload.issuedAt,
      expiresAt: null,
      valid: true,
      source: "offline",
      billing: "perpetual",
      status: "active",
      leaseExpiresAt: null,
      activationId: null,
    });
  });

  it("stays free with an expired offline license but reports it", () => {
    const e = buildEdition(config, offline({ valid: false, payload: basePayload, reason: "expired on 2025-01-01" }));
    expect(e.tier).toBe("free");
    expect(e.license?.valid).toBe(false);
    expect(e.license?.status).toBe("expired");
  });

  it("is pro + demo badge in DEMO_MODE regardless of license", () => {
    const e = buildEdition({ ...config, demoMode: true }, null);
    expect(e.tier).toBe("pro");
    expect(e.demo).toBe(true);
    expect(e.features.alerts).toBe(true);
  });

  describe("online (subscription) leases", () => {
    const lease: LicensePayload = {
      ...basePayload,
      expiresAt: NOW + 7 * 86_400_000,
      subscriptionExpiresAt: NOW + 30 * 86_400_000,
      activationId: "act_1",
      billing: "subscription",
    };
    const online = (verification: LicenseVerification, state: Partial<OnlineState> = {}): ResolvedLicense => ({
      source: "online",
      key: "BULLPANE-TEST",
      verification,
      state: { activationId: "act_1", lease: "x.y", lastCheckedAt: NOW, lastCheckError: null, ...state },
    });

    it("is active with a valid lease and a clean last check", () => {
      const e = buildEdition(config, online({ valid: true, payload: lease, reason: null }));
      expect(e.tier).toBe("pro");
      expect(e.license).toMatchObject({
        source: "online",
        billing: "subscription",
        status: "active",
        expiresAt: lease.subscriptionExpiresAt,
        leaseExpiresAt: lease.expiresAt,
        lastCheckedAt: NOW,
        lastCheckError: null,
        activationId: "act_1",
      });
    });

    it("is pro in grace when the API was unreachable but the lease still holds", () => {
      const e = buildEdition(
        config,
        online({ valid: true, payload: lease, reason: null }, { lastCheckError: { code: "network", message: "ECONNREFUSED", definitive: false } }),
      );
      expect(e.tier).toBe("pro");
      expect(e.license?.status).toBe("grace");
      expect(e.license?.lastCheckError).toBe("ECONNREFUSED");
    });

    it("is free once the lease ran out, even without a definitive answer", () => {
      const e = buildEdition(config, online({ valid: false, payload: lease, reason: "expired on x" }, { lastCheckError: { code: "network", message: "down", definitive: false } }));
      expect(e.tier).toBe("free");
      expect(e.license?.status).toBe("expired");
    });

    it("is free at once when the store said revoked, lease or not", () => {
      const e = buildEdition(config, online({ valid: true, payload: lease, reason: null }, { lastCheckError: { code: "license_revoked", message: "cancelled", definitive: true } }));
      expect(e.tier).toBe("free");
      expect(e.license?.status).toBe("invalid");
    });

    it("reports expired when the store said the paid period ended", () => {
      const e = buildEdition(config, online({ valid: true, payload: lease, reason: null }, { lastCheckError: { code: "license_expired", message: "ended", definitive: true } }));
      expect(e.license?.status).toBe("expired");
    });
  });
});

describe("isOfflineToken", () => {
  it("tells signed tokens from store keys", () => {
    const { privateKey } = keypair();
    expect(isOfflineToken(signLicense(basePayload, privateKey))).toBe(true);
    expect(isOfflineToken("BULLPANE-1234-ABCD-5678")).toBe(false);
    expect(isOfflineToken("a.b.c")).toBe(false);
    expect(isOfflineToken(".x")).toBe(false);
  });
});
