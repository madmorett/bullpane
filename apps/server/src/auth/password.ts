import bcrypt from "bcryptjs";

export const BCRYPT_ROUNDS = 10;

export function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, BCRYPT_ROUNDS);
}

/**
 * `hash` is nullable because an SSO-only account has no password (see
 * migrations/0005_sso.sql). A NULL hash is refused HERE rather than at each
 * call site, so no future login path can accidentally treat "has no password"
 * as "any password will do" — the failure mode that would turn SSO-only
 * accounts into open doors.
 */
export function verifyPassword(password: string, hash: string | null): Promise<boolean> {
  if (!hash) return Promise.resolve(false);
  return bcrypt.compare(password, hash);
}
