/**
 * Connection strings mean what they mean in psql.
 *
 * node-postgres (pg-connection-string 2.x) treats `sslmode=prefer|require|verify-ca`
 * as aliases for `verify-full`. A URL copied from RDS, Supabase or Neon with
 * `?sslmode=require` therefore fails against a server whose CA is not in Node's
 * trust store ("unable to verify the first certificate"), while the same URL
 * works in psql — the measured failure that motivated this file. Those three
 * modes get libpq semantics instead (`uselibpqcompat=true`): `require`
 * encrypts without verifying, `verify-ca` / `require` + `sslrootcert` verify
 * against that CA, `verify-full` verifies the host too.
 *
 * Only those three: `no-verify` (a node-postgres idiom) and `verify-full` keep
 * their node-postgres meaning, and an explicit `uselibpqcompat` is respected.
 */
const LIBPQ_ALIASED_MODES = new Set(["prefer", "require", "verify-ca"]);

export function nodePgConnectionString(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }
  const mode = parsed.searchParams.get("sslmode");
  if (!mode || !LIBPQ_ALIASED_MODES.has(mode) || parsed.searchParams.has("uselibpqcompat")) return url;
  parsed.searchParams.set("uselibpqcompat", "true");
  return parsed.toString();
}
