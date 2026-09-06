/**
 * Redis connections: CRUD in MySQL + resolution to an Inspector from the pool,
 * with a per-connection status cache (ping at most every 10 s).
 */
import {
  type ConnectionStatus,
  type CreateConnectionInput,
  type QueueSummary,
  type RedisConnection,
  redactRedisUrl,
  type UpdateConnectionInput,
} from "@bullmq-visualizer/shared";
import type { Inspector, InspectorPool, PingResult } from "@bullmq-visualizer/redis-inspector";
import { and, eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import type { Db } from "../db";
import { alerts, connections, type ConnectionRow, flowEdges, folderQueues } from "../db/schema";
import { notFound } from "../plugins/errors";
import { withRedis } from "./inspector-errors";

export const STATUS_TTL_MS = 10_000;

interface StatusCacheEntry {
  status: ConnectionStatus;
  checkedAt: number;
  inflight: Promise<ConnectionStatus> | null;
}

export function toConnectionDto(row: ConnectionRow, status?: ConnectionStatus): RedisConnection {
  const dto: RedisConnection = {
    id: row.id,
    name: row.name,
    url: redactRedisUrl(row.url),
    prefix: row.prefix,
    cluster: row.cluster,
    queueFilter: row.queueFilter ?? null,
    createdAt: row.createdAt.toISOString(),
  };
  if (status) dto.status = status;
  return dto;
}

export function pingToStatus(ping: PingResult, checkedAt = new Date()): ConnectionStatus {
  return {
    ok: ping.ok,
    latencyMs: ping.ok ? ping.latencyMs : null,
    redisVersion: ping.redisVersion,
    error: ping.error,
    checkedAt: checkedAt.toISOString(),
  };
}

export class ConnectionsService {
  /**
   * Called whenever a connection's inspector is evicted (edited or deleted), so
   * caches keyed by connection id (health samples, for one) can drop their state.
   * A callback rather than a direct import keeps this service dependency-free.
   */
  private readonly evictListeners: Array<(id: string) => void> = [];

  onEvict(fn: (id: string) => void): void {
    this.evictListeners.push(fn);
  }

  private notifyEvict(id: string): void {
    for (const fn of this.evictListeners) fn(id);
  }

  private readonly statusCache = new Map<string, StatusCacheEntry>();

  constructor(
    private readonly db: Db,
    private readonly pool: InspectorPool,
  ) {}

  async listRows(): Promise<ConnectionRow[]> {
    return this.db.select().from(connections).orderBy(connections.createdAt);
  }

  async getRow(id: string): Promise<ConnectionRow> {
    const rows = await this.db.select().from(connections).where(eq(connections.id, id)).limit(1);
    const row = rows[0];
    if (!row) throw notFound("Connection");
    return row;
  }

  async count(): Promise<number> {
    const rows = await this.db.select({ id: connections.id }).from(connections);
    return rows.length;
  }

  /** Every connection with its (cached) status, pinged in parallel. */
  async list(): Promise<RedisConnection[]> {
    const rows = await this.listRows();
    return Promise.all(rows.map(async (row) => toConnectionDto(row, await this.getStatus(row))));
  }

  async create(input: CreateConnectionInput): Promise<RedisConnection> {
    const id = nanoid();
    await this.db.insert(connections).values({
      id,
      name: input.name,
      url: input.url,
      prefix: input.prefix,
      cluster: input.cluster,
      queueFilter: input.queueFilter ?? null,
      createdAt: new Date(),
    });
    const row = await this.getRow(id);
    return toConnectionDto(row, await this.getStatus(row, { force: true }));
  }

  async update(id: string, input: UpdateConnectionInput): Promise<RedisConnection> {
    await this.getRow(id);
    const patch: Partial<typeof connections.$inferInsert> = {};
    if (input.name !== undefined) patch.name = input.name;
    if (input.url !== undefined) patch.url = input.url;
    if (input.prefix !== undefined) patch.prefix = input.prefix;
    if (input.cluster !== undefined) patch.cluster = input.cluster;
    if (input.queueFilter !== undefined) patch.queueFilter = input.queueFilter;
    if (Object.keys(patch).length > 0) {
      await this.db.update(connections).set(patch).where(eq(connections.id, id));
    }
    await this.pool.evict(id);
    this.notifyEvict(id);
    this.statusCache.delete(id);
    const row = await this.getRow(id);
    return toConnectionDto(row, await this.getStatus(row, { force: true }));
  }

  async remove(id: string): Promise<void> {
    await this.getRow(id);
    await this.pool.evict(id);
    this.notifyEvict(id);
    this.statusCache.delete(id);
    await this.db.delete(folderQueues).where(eq(folderQueues.connectionId, id));
    await this.db.delete(alerts).where(eq(alerts.connectionId, id));
    await this.db.delete(flowEdges).where(eq(flowEdges.connectionId, id));
    await this.db.delete(connections).where(eq(connections.id, id));
  }

  inspectorFor(row: ConnectionRow): Inspector {
    return this.pool.get({
      id: row.id,
      url: row.url,
      prefix: row.prefix,
      cluster: row.cluster,
      queueFilter: row.queueFilter,
    });
  }

  async getInspector(connectionId: string): Promise<Inspector> {
    return this.inspectorFor(await this.getRow(connectionId));
  }

  /** Cached ping (10 s). Concurrent callers share one in-flight ping. */
  async getStatus(row: ConnectionRow, opts: { force?: boolean } = {}): Promise<ConnectionStatus> {
    const now = Date.now();
    const cached = this.statusCache.get(row.id);
    if (cached && !opts.force && now - cached.checkedAt < STATUS_TTL_MS) return cached.status;
    if (cached?.inflight) return cached.inflight;

    const inflight = (async (): Promise<ConnectionStatus> => {
      let status: ConnectionStatus;
      try {
        status = pingToStatus(await this.inspectorFor(row).ping());
      } catch (err) {
        status = {
          ok: false,
          latencyMs: null,
          redisVersion: null,
          error: err instanceof Error ? err.message : String(err),
          checkedAt: new Date().toISOString(),
        };
      }
      this.statusCache.set(row.id, { status, checkedAt: Date.now(), inflight: null });
      return status;
    })();
    this.statusCache.set(row.id, { status: cached?.status ?? pendingStatus(), checkedAt: cached?.checkedAt ?? 0, inflight });
    return inflight;
  }

  /** Discovery + one pipelined stats call. The sidebar polls this. */
  async listQueues(row: ConnectionRow, opts: { refresh?: boolean; withMetrics?: boolean } = {}): Promise<QueueSummary[]> {
    const inspector = this.inspectorFor(row);
    return withRedis(async () => {
      const names = await inspector.discoverQueues({ force: opts.refresh === true });
      if (names.length === 0) return [];
      const stats = await inspector.getQueueStats(names, opts.withMetrics ? { withMetrics: true } : undefined);
      return names.map((name) => {
        const s = stats[name];
        return {
          name,
          prefix: row.prefix,
          counts: s?.counts ?? emptyCounts(),
          isPaused: s?.isPaused ?? false,
          isPro: s?.isPro ?? false,
          groupsCount: s?.groupsCount ?? 0,
          rates: s?.rates ?? { windowMinutes: 60, completed: 0, failed: 0, successPct: null },
          ...(s?.metrics ? { metrics: s.metrics } : {}),
        };
      });
    });
  }

  async findByQueue(id: string, queueName: string): Promise<{ row: ConnectionRow; inspector: Inspector }> {
    const row = await this.getRow(id);
    return { row, inspector: this.inspectorFor(row) };
  }

  /** Used by seeding: does a connection with this name exist? */
  async findByName(name: string): Promise<ConnectionRow | null> {
    const rows = await this.db.select().from(connections).where(and(eq(connections.name, name))).limit(1);
    return rows[0] ?? null;
  }
}

function pendingStatus(): ConnectionStatus {
  return { ok: false, latencyMs: null, redisVersion: null, error: "checking", checkedAt: new Date().toISOString() };
}

function emptyCounts() {
  return {
    waiting: 0,
    active: 0,
    completed: 0,
    failed: 0,
    delayed: 0,
    prioritized: 0,
    paused: 0,
    "waiting-children": 0,
  };
}
