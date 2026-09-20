/**
 * The server only ever stores a Redis URL. The connection form offers separate
 * fields (host, port, user, password, database, TLS) because that is how most
 * providers hand credentials out, and asking people to assemble
 * `rediss://user:p%40ss@host:6380/0` by hand is how typos in passwords happen.
 * These two functions are the bridge; the API contract does not change.
 */
export interface RedisParts {
  host: string;
  port: string;
  username: string;
  password: string;
  db: string;
  tls: boolean;
}

export const DEFAULT_REDIS_PARTS: RedisParts = { host: "localhost", port: "6379", username: "", password: "", db: "0", tls: false };

/** Parses a redis:// or rediss:// URL. A redacted password ("****", as the API returns it) comes back empty. */
export function partsFromUrl(url: string): RedisParts {
  try {
    const u = new URL(url);
    if (u.protocol !== "redis:" && u.protocol !== "rediss:") return { ...DEFAULT_REDIS_PARTS };
    const password = safeDecode(u.password);
    return {
      host: u.hostname || DEFAULT_REDIS_PARTS.host,
      port: u.port || (u.protocol === "rediss:" ? "6380" : "6379"),
      username: safeDecode(u.username),
      password: password === "****" ? "" : password,
      db: u.pathname.replace(/^\//, "") || "0",
      tls: u.protocol === "rediss:",
    };
  } catch {
    return { ...DEFAULT_REDIS_PARTS };
  }
}

export function urlFromParts(p: RedisParts): string {
  const auth = p.username || p.password ? `${encodeURIComponent(p.username)}:${encodeURIComponent(p.password)}@` : "";
  const host = p.host.includes(":") && !p.host.startsWith("[") ? `[${p.host}]` : p.host; // IPv6
  const db = p.db.trim() && p.db.trim() !== "0" ? `/${p.db.trim()}` : "";
  return `${p.tls ? "rediss" : "redis"}://${auth}${host.trim()}:${p.port.trim() || "6379"}${db}`;
}

/** True when host, port, user, database or TLS differ; the password is deliberately not compared. */
export function partsChanged(a: RedisParts, b: RedisParts): boolean {
  return a.host !== b.host || a.port !== b.port || a.username !== b.username || a.db !== b.db || a.tls !== b.tls;
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}
