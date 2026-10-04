/**
 * Every inspector call goes through `withRedis` so a dead Redis becomes a
 * 502 `redis_unavailable`, a missing job a 404, and a BullMQ state complaint
 * (e.g. retrying a job that is not failed) a 409 `conflict`.
 */
import { conflict, errorMessage, HttpError, notFound, redisUnavailable } from "../plugins/errors";

const CONNECTION_ERROR_PATTERNS = [
  /ECONNREFUSED/i,
  /ECONNRESET/i,
  /ETIMEDOUT/i,
  /ENOTFOUND/i,
  /EHOSTUNREACH/i,
  /EAI_AGAIN/i,
  /connection is closed/i,
  /connect timeout/i,
  /stream isn'?t writeable/i,
  /enableOfflineQueue/i,
  /MaxRetriesPerRequest/i,
  /NOAUTH/i,
  /WRONGPASS/i,
  /invalid password/i,
  /LOADING Redis is loading/i,
  /CLUSTERDOWN/i,
  /Failed to refresh slots cache/i,
  /All sentinels are unreachable/i,
  /socket closed unexpectedly/i,
  // Postgres (node-postgres / BullMQ's Postgres backend)
  /password authentication failed/i,
  /no pg_hba\.conf entry/i,
  /Connection terminated/i,
  /timeout exceeded when trying to connect/i,
  /the database system is (starting up|shutting down)/i,
  /too many clients already/i,
  /postgres_schema_missing/,
  /the PostgreSQL schema requires BullMQ/i,
  /the PostgreSQL backend requires server version/i,
];

const NOT_FOUND_PATTERNS = [/missing key for job/i, /job .* not found/i, /could not be found/i, /does not exist/i];

export function isRedisConnectionError(err: unknown): boolean {
  if (typeof err === "object" && err !== null) {
    const name = (err as { name?: string }).name ?? "";
    if (name === "MaxRetriesPerRequestError" || name === "ClusterAllFailedError") return true;
    const code = (err as { code?: string }).code;
    if (code && CONNECTION_ERROR_PATTERNS.some((p) => p.test(code))) return true;
    // Postgres SQLSTATE: class 08 (connection exception), 28 (invalid authorization),
    // 3D000 (database does not exist), 57P0x (admin shutdown / cannot connect now).
    if (code && /^(08...|28...|3D000|57P0\d)$/.test(code)) return true;
  }
  const message = errorMessage(err);
  return CONNECTION_ERROR_PATTERNS.some((p) => p.test(message));
}

export function mapInspectorError(err: unknown): HttpError {
  if (err instanceof HttpError) return err;
  if (isRedisConnectionError(err)) return redisUnavailable(err);
  const message = errorMessage(err);
  if (NOT_FOUND_PATTERNS.some((p) => p.test(message))) return notFound("Job");
  return conflict(message);
}

export async function withRedis<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    throw mapInspectorError(err);
  }
}
