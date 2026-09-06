/**
 * Builds ioredis clients from an InspectorConnectionConfig.
 *
 * Two kinds of client leave this file:
 *  1. the inspector's own read client (fail-fast: nothing queues while Redis is down)
 *  2. the connection bullmq gets for writes. bullmq builds a plain `IORedis` from an
 *     options object (redis-connection.js), never a Cluster, so in cluster mode we
 *     hand it a ready-made `Redis.Cluster` instance and own its lifecycle.
 */
import Redis, { Cluster, type ClusterNode, type ClusterOptions, type RedisOptions } from "ioredis";
import type { ConnectionOptions as BullConnectionOptions } from "bullmq";
import type { InspectorConnectionConfig } from "./types.js";

export interface ParsedRedisUrl {
  host: string;
  port: number;
  username?: string;
  password?: string;
  db?: number;
  tls: boolean;
}

/** `redis://user:pass@host:6379/2` -> parts. `rediss://` turns TLS on. */
export function parseRedisUrl(url: string): ParsedRedisUrl {
  const u = new URL(url);
  const out: ParsedRedisUrl = {
    host: u.hostname || "127.0.0.1",
    port: u.port ? parseInt(u.port, 10) : 6379,
    tls: u.protocol === "rediss:",
  };
  if (u.username) out.username = decodeURIComponent(u.username);
  if (u.password) out.password = decodeURIComponent(u.password);
  const db = u.pathname.replace(/^\//, "");
  if (db && /^\d+$/.test(db)) out.db = parseInt(db, 10);
  return out;
}

/**
 * Fail-fast defaults (ARCHITECTURE.md, rule 7).
 *  - lazyConnect: the pool creates inspectors eagerly; we connect on first use.
 *  - enableOfflineQueue false: a dead Redis rejects immediately instead of hanging.
 *  - maxRetriesPerRequest 1: one retry, then the caller gets the error.
 *  - retryStrategy: keep reconnecting in the background (capped at 5 s) so the
 *    badge turns green again on its own when Redis comes back.
 */
export function readClientOptions(connectTimeoutMs: number): RedisOptions {
  return {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    enableReadyCheck: true,
    connectTimeout: connectTimeoutMs,
    retryStrategy: (times) => Math.min(times * 500, 5000),
  };
}

function clusterOptions(parsed: ParsedRedisUrl, redisOptions: RedisOptions): ClusterOptions {
  // ioredis owns these per node in cluster mode; they live on ClusterOptions instead.
  const { lazyConnect, enableOfflineQueue, retryStrategy: _r, ...perNode } = redisOptions;
  return {
    lazyConnect,
    enableOfflineQueue,
    enableReadyCheck: redisOptions.enableReadyCheck,
    clusterRetryStrategy: (times) => Math.min(times * 500, 5000),
    redisOptions: {
      ...perNode,
      username: parsed.username,
      password: parsed.password,
      ...(parsed.tls ? { tls: {} } : {}),
    },
  };
}

function clusterNodes(parsed: ParsedRedisUrl): ClusterNode[] {
  return [{ host: parsed.host, port: parsed.port }];
}

/** The inspector's read client. */
export function createReadClient(config: InspectorConnectionConfig, connectTimeoutMs: number): Redis | Cluster {
  const base = readClientOptions(connectTimeoutMs);
  if (config.cluster) {
    const parsed = parseRedisUrl(config.url);
    return new Cluster(clusterNodes(parsed), clusterOptions(parsed, base));
  }
  // `new Redis(url, options)`: ioredis parses the URL (incl. rediss:// => tls) and merges options.
  return new Redis(config.url, base);
}

/**
 * What bullmq's Queue receives as `connection`.
 * Non-cluster: an options object with `url` so bullmq owns its client and its lifecycle.
 * Cluster: a dedicated Cluster instance (returned so the caller can close it).
 */
export function createBullmqConnection(
  config: InspectorConnectionConfig,
  connectTimeoutMs: number,
): { connection: BullConnectionOptions; ownedCluster: Cluster | null } {
  if (config.cluster) {
    const parsed = parseRedisUrl(config.url);
    const base: RedisOptions = { connectTimeout: connectTimeoutMs, maxRetriesPerRequest: null };
    const cluster = new Cluster(clusterNodes(parsed), {
      ...clusterOptions(parsed, base),
      lazyConnect: false,
      enableOfflineQueue: true,
    });
    return { connection: cluster, ownedCluster: cluster };
  }
  return {
    connection: {
      url: config.url,
      connectTimeout: connectTimeoutMs,
      // bullmq's recommendation for its own clients; commands wait for reconnection.
      maxRetriesPerRequest: null,
      retryStrategy: (times: number) => Math.min(times * 500, 5000),
    },
    ownedCluster: null,
  };
}
