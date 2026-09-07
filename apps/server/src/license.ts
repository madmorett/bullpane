/**
 * Ed25519 license verification. Used for both hand-signed perpetual keys and the
 * short-lived leases the license API issues for subscription keys.
 * Key format: base64url(payloadJson) + "." + base64url(signature).
 * The signature is over the raw base64url payload string (ASCII bytes).
 */
import { createPrivateKey, sign as cryptoSign, verify as cryptoVerify, type KeyObject } from "node:crypto";
import type { LicensePayload } from "@bullmq-visualizer/shared";
import { z } from "zod";

/**
 * Bullpane vendor public key (DER/SPKI, base64). The private half signs offline
 * keys (scripts/gen-license.ts) and the leases issued by api.bullpane.com; it
 * lives in /keys/license-private.pem on the vendor machine (gitignored) and as
 * a secret of the license API worker. Override at runtime with
 * LICENSE_PUBLIC_KEY_B64, e.g. to test against a local license API.
 */
export const LICENSE_PUBLIC_KEY_B64 = "MCowBQYDK2VwAyEAiOdWgp41hqTFeVlG0WO0qH3T4bPZpoUeUHUlxk5Lwis=";

export const licensePayloadSchema = z.object({
  licensee: z.string().min(1),
  email: z.string().min(1),
  plan: z.literal("pro"),
  issuedAt: z.number().int(),
  expiresAt: z.number().int().nullable(),
  notes: z.string().optional(),
  // Lease fields, written by the license API for subscription keys.
  activationId: z.string().min(1).optional(),
  subscriptionExpiresAt: z.number().int().nullable().optional(),
  billing: z.enum(["subscription", "perpetual"]).optional(),
});

/**
 * An offline token is `payload.signature` (two base64url parts). Anything else
 * the admin pastes is treated as a store key (Polar: `BULLPANE-XXXX-…`, no dot)
 * and goes through the license API.
 */
export function isOfflineToken(key: string): boolean {
  const parts = key.trim().split(".");
  return parts.length === 2 && parts[0] !== "" && parts[1] !== "";
}

export type LicenseVerification =
  | { valid: true; payload: LicensePayload; reason: null }
  | { valid: false; payload: LicensePayload | null; reason: string };

export interface VerifyOptions {
  /** DER/SPKI base64 public key. Defaults to the compiled-in key. */
  publicKeyB64?: string | null;
  /** unix ms, defaults to Date.now() */
  now?: number;
}

export function verifyLicenseKey(key: string, opts: VerifyOptions = {}): LicenseVerification {
  const publicKeyB64 = opts.publicKeyB64 ?? LICENSE_PUBLIC_KEY_B64;
  const now = opts.now ?? Date.now();

  const trimmed = key.trim();
  const parts = trimmed.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    return { valid: false, payload: null, reason: "malformed key (expected payload.signature)" };
  }
  const [payloadB64, signatureB64] = parts as [string, string];

  let payload: LicensePayload;
  try {
    const raw: unknown = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8"));
    payload = licensePayloadSchema.parse(raw);
  } catch {
    return { valid: false, payload: null, reason: "payload is not a valid license document" };
  }

  let signatureOk = false;
  try {
    signatureOk = cryptoVerify(
      null,
      Buffer.from(payloadB64),
      { key: Buffer.from(publicKeyB64, "base64"), format: "der", type: "spki" },
      Buffer.from(signatureB64, "base64url"),
    );
  } catch {
    signatureOk = false;
  }
  if (!signatureOk) return { valid: false, payload, reason: "signature does not match" };

  if (payload.expiresAt !== null && payload.expiresAt <= now) {
    return { valid: false, payload, reason: `expired on ${new Date(payload.expiresAt).toISOString()}` };
  }
  return { valid: true, payload, reason: null };
}

/** Vendor side. Used by scripts/print-dev-license.ts and the tests. */
export function signLicense(payload: LicensePayload, privateKey: KeyObject | string): string {
  const keyObject = typeof privateKey === "string" ? createPrivateKey(privateKey) : privateKey;
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = cryptoSign(null, Buffer.from(payloadB64), keyObject);
  return `${payloadB64}.${signature.toString("base64url")}`;
}
