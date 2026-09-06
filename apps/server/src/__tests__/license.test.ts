import { generateKeyPairSync } from "node:crypto";
import type { LicensePayload } from "@bullmq-visualizer/shared";
import { describe, expect, it } from "vitest";
import { signLicense, verifyLicenseKey } from "../license";
import { buildEdition } from "../services/edition";

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

  it("is free without a license", () => {
    const e = buildEdition(config, null);
    expect(e.tier).toBe("free");
    expect(e.demo).toBe(false);
    expect(e.features).toEqual({ alerts: false, users: false, folders: false, flows: false });
    expect(e.license).toBeNull();
    expect(e.priceUsd).toBe(49);
    expect(e.checkoutUrl).toBe("https://example.test/pro");
  });

  it("is pro with a valid license", () => {
    const e = buildEdition(config, { valid: true, payload: basePayload, reason: null });
    expect(e.tier).toBe("pro");
    expect(e.features).toEqual({ alerts: true, users: true, folders: true, flows: true });
    expect(e.license).toEqual({ licensee: "Acme Corp", email: "ops@acme.test", issuedAt: basePayload.issuedAt, expiresAt: null, valid: true });
  });

  it("stays free with an invalid license but reports it", () => {
    const e = buildEdition(config, { valid: false, payload: basePayload, reason: "expired" });
    expect(e.tier).toBe("free");
    expect(e.license?.valid).toBe(false);
  });

  it("is pro + demo badge in DEMO_MODE regardless of license", () => {
    const e = buildEdition({ ...config, demoMode: true }, null);
    expect(e.tier).toBe("pro");
    expect(e.demo).toBe(true);
    expect(e.features.alerts).toBe(true);
  });
});
