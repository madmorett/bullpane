/**
 * Encryption at rest for SSO client secrets.
 *
 * An OIDC client secret must be REPLAYED to the IdP's token endpoint, so unlike
 * a password it cannot be hashed — it has to come back out. AES-256-GCM with a
 * key derived from SESSION_SECRET is the trade: an attacker with a dump of
 * MySQL (a backup, a read replica, a `mysqldump` in a ticket) does not get the
 * customer's IdP credentials, because the key is in the environment and not in
 * the database.
 *
 * What this is NOT: protection against an attacker who already has the server's
 * environment. Nothing stored on a box the attacker owns can be. A KMS would
 * move the key off the box, and that is the upgrade path — the format below is
 * versioned (`v1.`) precisely so it can be introduced without a data migration.
 *
 * OPERATOR CONSEQUENCE: rotating SESSION_SECRET makes every stored secret
 * undecryptable. Decryption failure is surfaced as a clear error telling the
 * admin to re-enter the secret, never as a silent "SSO stopped working".
 */
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes, timingSafeEqual } from "node:crypto";

const VERSION = "v1";
const ALGO = "aes-256-gcm";
const IV_BYTES = 12; // 96-bit nonce, the GCM standard
const KEY_BYTES = 32;
const TAG_BYTES = 16;

/**
 * SESSION_SECRET is a cookie-signing secret, not a cryptographic key: it may be
 * any 32+ characters a human picked. HKDF turns it into a uniformly random key,
 * and the distinct `info` string means this key can never coincide with one
 * derived for some other purpose from the same secret.
 */
export function deriveKey(sessionSecret: string): Buffer {
  return Buffer.from(hkdfSync("sha256", Buffer.from(sessionSecret, "utf8"), Buffer.alloc(0), "bullpane:sso:secret:v1", KEY_BYTES));
}

export class SecretDecryptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SecretDecryptError";
  }
}

/** Returns `v1.<iv>.<tag>.<ciphertext>`, all base64url. */
export function encryptSecret(plaintext: string, sessionSecret: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGO, deriveKey(sessionSecret), iv);
  const data = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString("base64url"), tag.toString("base64url"), data.toString("base64url")].join(".");
}

export function decryptSecret(stored: string, sessionSecret: string): string {
  const parts = stored.split(".");
  if (parts.length !== 4 || parts[0] !== VERSION) {
    throw new SecretDecryptError("Stored secret is not in the expected format");
  }
  const iv = Buffer.from(parts[1] as string, "base64url");
  const tag = Buffer.from(parts[2] as string, "base64url");
  const data = Buffer.from(parts[3] as string, "base64url");
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
    throw new SecretDecryptError("Stored secret is not in the expected format");
  }
  try {
    const decipher = createDecipheriv(ALGO, deriveKey(sessionSecret), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
  } catch {
    /**
     * GCM authentication failed. In practice this means SESSION_SECRET changed
     * since the secret was saved (or the row was tampered with). Both need the
     * same human action, and neither should leak which one it was.
     */
    throw new SecretDecryptError(
      "Could not decrypt the stored SSO secret. This usually means SESSION_SECRET changed; re-enter the client secret to fix it.",
    );
  }
}

/**
 * Constant-time compare for the OAuth `state` and SAML `RelayState` values we
 * hand out and get back. `===` on a secret leaks its prefix through timing;
 * cheap to avoid, so avoided.
 */
export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}
