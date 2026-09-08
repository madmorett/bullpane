import { describe, expect, it } from "vitest";
import { decryptSecret, deriveKey, encryptSecret, safeEqual, SecretDecryptError } from "../auth/sso/crypto";

const SECRET = "s".repeat(40);
const OTHER = "o".repeat(40);

describe("sso secret encryption", () => {
  it("round-trips a client secret", () => {
    const stored = encryptSecret("super-secret-value", SECRET);
    expect(decryptSecret(stored, SECRET)).toBe("super-secret-value");
  });

  it("never stores the plaintext", () => {
    const stored = encryptSecret("super-secret-value", SECRET);
    expect(stored).not.toContain("super-secret-value");
    expect(stored.startsWith("v1.")).toBe(true);
  });

  it("produces a different ciphertext each time (fresh iv)", () => {
    // A deterministic ciphertext would tell an attacker with a dump which
    // providers share a secret.
    expect(encryptSecret("same", SECRET)).not.toBe(encryptSecret("same", SECRET));
  });

  it("refuses to decrypt with a rotated SESSION_SECRET, with an actionable message", () => {
    const stored = encryptSecret("super-secret-value", SECRET);
    expect(() => decryptSecret(stored, OTHER)).toThrow(SecretDecryptError);
    expect(() => decryptSecret(stored, OTHER)).toThrow(/SESSION_SECRET changed/);
  });

  it("refuses tampered ciphertext (GCM auth)", () => {
    const stored = encryptSecret("super-secret-value", SECRET);
    const parts = stored.split(".");
    const data = Buffer.from(parts[3] as string, "base64url");
    data[0] = (data[0] as number) ^ 0xff;
    const tampered = [parts[0], parts[1], parts[2], data.toString("base64url")].join(".");
    expect(() => decryptSecret(tampered, SECRET)).toThrow(SecretDecryptError);
  });

  it("refuses malformed and unversioned input instead of crashing", () => {
    for (const bad of ["", "nonsense", "v1.only.three", "v2.a.b.c"]) {
      expect(() => decryptSecret(bad, SECRET)).toThrow(SecretDecryptError);
    }
  });

  it("derives a stable 32-byte key, distinct per secret", () => {
    expect(deriveKey(SECRET)).toHaveLength(32);
    expect(deriveKey(SECRET).equals(deriveKey(SECRET))).toBe(true);
    expect(deriveKey(SECRET).equals(deriveKey(OTHER))).toBe(false);
  });
});

describe("safeEqual", () => {
  it("matches identical values and rejects everything else", () => {
    expect(safeEqual("abc", "abc")).toBe(true);
    expect(safeEqual("abc", "abd")).toBe(false);
    // Different lengths must not throw (timingSafeEqual would).
    expect(safeEqual("abc", "abcd")).toBe(false);
    expect(safeEqual("", "")).toBe(true);
  });
});
