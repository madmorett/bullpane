/**
 * Redis connections: CRUD in MySQL + resolution to an Inspector from the pool,
 * with a per-connection status cache (ping at most every 10 s).
 */
import {
  type ConnectionStatus,
  type CreateConnectionInput,
  type HiddenQueue,
  type QueueSummary,
  type RedisConnection,
  redactRedisUrl,
  type UpdateConnectionInput,
} from "@bullpane/shared";
import type { Inspector, InspectorPool, PingResult } from "@bullpane/redis-inspector";
import { and, eq, inArray } from "drizzle-orm";
import { nanoid } from "nanoid";
import type { Db } from "../db";
import { alerts, connections, type ConnectionRow, flowEdges, folderQueues, hiddenQueues, users } from "../db/schema";
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
    await this.db.delete(hiddenQueues).where(eq(hiddenQueues.connectionId, id));
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

  // -------------------------------------------------------------------------
  // Hidden queues
  //
  // Hiding is filtered HERE, in the service, and never in the inspector's
  // discovery. Three reasons:
  //   (a) the inspector is stateless and knows nothing about MySQL — teaching
  //       it about hidden rows would couple the Redis layer to the database;
  //   (b) a hidden queue must stay measurable: the alerts engine calls the
  //       inspector directly, so hiding must not silence an alert;
  //   (c) a hidden queue must stay reachable by direct URL
  //       (GET /connections/:id/queues/:queue is untouched).
  // Hiding is about the LIST, not about switching the queue off.
  //
  // Scope is the instance, not the user — see migrations/0003_hidden_queues.sql.
  // -------------------------------------------------------------------------

  /** Names hidden on this connection, as a Set for O(1) filtering. */
  async hiddenQueueNames(connectionId: string): Promise<Set<string>> {
    const rows = await this.db
      .select({ queueName: hiddenQueues.queueName })
      .from(hiddenQueues)
      .where(eq(hiddenQueues.connectionId, connectionId));
    return new Set(rows.map((r) => r.queueName));
  }

  /** The hidden list for the UI, newest first, with the display name of who hid it. */
  async listHiddenQueues(connectionId: string): Promise<HiddenQueue[]> {
    const rows = await this.db
      .select()
      .from(hiddenQueues)
      .where(eq(hiddenQueues.connectionId, connectionId))
      .orderBy(hiddenQueues.hiddenAt);

    const ids = [...new Set(rows.map((r) => r.hiddenBy).filter((v): v is string => !!v))];
    const names = new Map<string, string>();
    if (ids.length > 0) {
      const found = await this.db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, ids));
      for (const u of found) names.set(u.id, u.name);
    }

    return rows
      .map((r) => ({
        connectionId: r.connectionId,
        queueName: r.queueName,
        hiddenAt: r.hiddenAt.toISOString(),
        hiddenBy: r.hiddenBy ?? null,
        // A deleted user leaves the row intact; the name just becomes unknown.
        hiddenByName: r.hiddenBy ? (names.get(r.hiddenBy) ?? null) : null,
      }))
      .sort((a, b) => b.hiddenAt.localeCompare(a.hiddenAt));
  }

  /** Idempotent: hiding an already hidden queue is a no-op, not a 409. */
  async hideQueue(connectionId: string, queueName: string, userId: string | null): Promise<HiddenQueue[]> {
    await this.getRow(connectionId);
    const existing = await this.db
      .select({ queueName: hiddenQueues.queueName })
      .from(hiddenQueues)
      .where(and(eq(hiddenQueues.connectionId, connectionId), eq(hiddenQueues.queueName, queueName)))
      .limit(1);
    if (existing.length === 0) {
      await this.db.insert(hiddenQueues).values({ connectionId, queueName, hiddenAt: new Date(), hiddenBy: userId });
    }
    return this.listHiddenQueues(connectionId);
  }

  /** Idempotent too: unhiding something that is not hidden succeeds. */
  async unhideQueue(connectionId: string, queueName: string): Promise<HiddenQueue[]> {
    await this.getRow(connectionId);
    await this.db
      .delete(hiddenQueues)
      .where(and(eq(hiddenQueues.connectionId, connectionId), eq(hiddenQueues.queueName, queueName)));
    return this.listHiddenQueues(connectionId);
  }

  async isQueueHidden(connectionId: string, queueName: string): Promise<boolean> {
    const rows = await this.db
      .select({ queueName: hiddenQueues.queueName })
      .from(hiddenQueues)
      .where(and(eq(hiddenQueues.connectionId, connectionId), eq(hiddenQueues.queueName, queueName)))
      .limit(1);
    return rows.length > 0;
  }

  /**
   * Discovery + one pipelined stats call. The sidebar polls this.
   *
   * Hidden queues are dropped between discovery and stats, so a hidden queue
   * costs no Redis work at all here. `includeHidden: true` skips the MySQL read
   * entirely and behaves exactly as before this feature existed.
   */
  async listQueues(
    row: ConnectionRow,
    opts: { refresh?: boolean; withMetrics?: boolean; includeHidden?: boolean } = {},
  ): Promise<QueueSummary[]> {
    const inspector = this.inspectorFor(row);
    const hidden = opts.includeHidden ? new Set<string>() : await this.hiddenQueueNames(row.id);
    return withRedis(async () => {
      const all = await inspector.discoverQueues({ force: opts.refresh === true });
      const names = hidden.size === 0 ? all : all.filter((n) => !hidden.has(n));
      if (names.length === 0) return [];
      const stats = await inspector.getQueueStats(names, opts.withMetrics ? { withMetrics: true } : undefined);
      return names.map((name): QueueSummary => {
        const s = stats[name];
        return {
          name,
          prefix: row.prefix,
          counts: s?.counts ?? emptyCounts(),
          isPaused: s?.isPaused ?? false,
          isPro: s?.isPro ?? false,
          groupsCount: s?.groupsCount ?? 0,
          schedulersCount: s?.schedulersCount ?? 0,
          // Not a state, so it stays out of `counts`: a stalled job is still
          // `active` as far as BullMQ is concerned. See QueueSummary.stalledCount.
          stalledCount: s?.stalledCount ?? 0,
          // Queue whose stats call failed: the zeros come from the zsets (source "zset")
          // and nothing was pruned to skew the ratio, so retentionSkewed is false.
          rates: s?.rates ?? { windowMinutes: 60, completed: 0, failed: 0, successPct: null, source: "zset", retentionSkewed: false },
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
