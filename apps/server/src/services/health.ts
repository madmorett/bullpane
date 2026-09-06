/**
 * Redis health sampling for the homepage monitor.
 *
 * Why this lives on the server and not in the browser:
 *  - INFO gives CUMULATIVE counters (total_commands_processed, used_cpu_*).
 *    Turning those into "commands/sec" and "CPU cores" needs two samples and the
 *    time between them. Doing that server-side means every browser tab agrees,
 *    and opening five tabs does not multiply the load on the customer's Redis.
 *  - Samples are shared and rate-limited: one INFO per connection per
 *    MIN_SAMPLE_INTERVAL_MS no matter how many people are watching.
 *
 * Cost: one INFO per connection per poll. INFO is O(1).
 */
import type { ConnectionHealth, HealthPoint, HealthWarning, RedisServerInfo } from "@bullmq-visualizer/shared";
import type { ConnectionsService } from "./connections";
import type { ConnectionRow } from "../db/schema";

/** Never hit a customer's Redis more often than this, however hard the UI polls. */
const MIN_SAMPLE_INTERVAL_MS = 2_000;
/** ~10 minutes of history at a 3 s poll. Kept in memory only; this is a live view, not a TSDB. */
const HISTORY_POINTS = 200;

interface Snapshot {
  at: number;
  info: RedisServerInfo | null;
  error: string | null;
  commandsPerSec: number | null;
  cpuCores: number | null;
}

interface ConnectionState {
  last: Snapshot | null;
  inflight: Promise<Snapshot> | null;
  history: HealthPoint[];
}

export class HealthService {
  private readonly state = new Map<string, ConnectionState>();

  constructor(private readonly connections: ConnectionsService) {}

  /** Health for every configured connection, sampled in parallel. */
  async listAll(): Promise<ConnectionHealth[]> {
    const rows = await this.connections.listRows();
    return Promise.all(rows.map((row) => this.get(row)));
  }

  async getById(connectionId: string): Promise<ConnectionHealth> {
    return this.get(await this.connections.getRow(connectionId));
  }

  async get(row: ConnectionRow): Promise<ConnectionHealth> {
    const st = this.stateFor(row.id);
    const snap = await this.sample(row, st);
    const info = snap.info;
    const memoryUsedPct =
      info && info.maxMemoryBytes && info.maxMemoryBytes > 0
        ? Math.round((info.usedMemoryBytes / info.maxMemoryBytes) * 1000) / 10
        : null;

    return {
      connectionId: row.id,
      connectionName: row.name,
      ok: snap.error === null,
      error: snap.error,
      info,
      commandsPerSec: snap.commandsPerSec,
      cpuCores: snap.cpuCores,
      memoryUsedPct,
      history: [...st.history],
      warnings: buildWarnings(info, snap.error, memoryUsedPct),
    };
  }

  /** Drop cached state when a connection is edited or deleted. */
  evict(connectionId: string): void {
    this.state.delete(connectionId);
  }

  private stateFor(id: string): ConnectionState {
    let st = this.state.get(id);
    if (!st) {
      st = { last: null, inflight: null, history: [] };
      this.state.set(id, st);
    }
    return st;
  }

  /**
   * At most one INFO in flight per connection, and at most one per
   * MIN_SAMPLE_INTERVAL_MS. Concurrent callers share the same result.
   */
  private async sample(row: ConnectionRow, st: ConnectionState): Promise<Snapshot> {
    const now = Date.now();
    if (st.last && now - st.last.at < MIN_SAMPLE_INTERVAL_MS) return st.last;
    if (st.inflight) return st.inflight;

    const previous = st.last;
    st.inflight = (async (): Promise<Snapshot> => {
      const inspector = this.connections.inspectorFor(row);
      try {
        const info = await inspector.serverInfo();
        const at = Date.now();
        const elapsedSec = previous && previous.at ? (at - previous.at) / 1000 : 0;
        const snap: Snapshot = {
          at,
          info,
          error: null,
          commandsPerSec: rate(previous?.info?.totalCommandsProcessed, info.totalCommandsProcessed, elapsedSec),
          cpuCores: rate(previous?.info?.cpuSecondsTotal, info.cpuSecondsTotal, elapsedSec),
        };
        pushHistory(st, snap);
        return snap;
      } catch (err) {
        return {
          at: Date.now(),
          info: null,
          error: err instanceof Error ? err.message : String(err),
          commandsPerSec: null,
          cpuCores: null,
        };
      } finally {
        st.inflight = null;
      }
    })();

    const snap = await st.inflight;
    st.last = snap;
    return snap;
  }
}

/**
 * Per-second rate between two cumulative readings. Returns null on the first
 * sample, on a counter reset (Redis restarted), or when no time has passed.
 */
function rate(before: number | null | undefined, after: number | null | undefined, elapsedSec: number): number | null {
  if (before === null || before === undefined || after === null || after === undefined) return null;
  if (elapsedSec <= 0) return null;
  const delta = after - before;
  if (delta < 0) return null; // counter reset
  return Math.round((delta / elapsedSec) * 100) / 100;
}

function pushHistory(st: ConnectionState, snap: Snapshot): void {
  if (!snap.info) return;
  st.history.push({
    t: snap.at,
    latencyMs: snap.info.latencyMs,
    memoryBytes: snap.info.usedMemoryBytes,
    commandsPerSec: snap.commandsPerSec,
    cpuCores: snap.cpuCores,
    connectedClients: snap.info.connectedClients,
  });
  if (st.history.length > HISTORY_POINTS) st.history.splice(0, st.history.length - HISTORY_POINTS);
}

/**
 * Warnings are computed here, once, so the UI never invents its own thresholds.
 * These are the things that actually break a queue Redis.
 */
export function buildWarnings(
  info: RedisServerInfo | null,
  error: string | null,
  memoryUsedPct: number | null,
): HealthWarning[] {
  const out: HealthWarning[] = [];
  if (error !== null || info === null) {
    out.push({ level: "critical", code: "unreachable", message: error ?? "Redis is unreachable" });
    return out;
  }
  if (memoryUsedPct !== null && memoryUsedPct >= 90) {
    out.push({
      level: "critical",
      code: "memory_high",
      message: `Memory at ${memoryUsedPct}% of maxmemory${
        info.maxMemoryPolicy === "noeviction" ? " with noeviction: writes will start failing" : ""
      }`,
    });
  } else if (memoryUsedPct !== null && memoryUsedPct >= 75) {
    out.push({ level: "warn", code: "memory_high", message: `Memory at ${memoryUsedPct}% of maxmemory` });
  }
  if (info.evictedKeys !== null && info.evictedKeys > 0) {
    out.push({
      level: "critical",
      code: "eviction",
      message: `${info.evictedKeys.toLocaleString()} keys evicted: a queue Redis losing keys is losing jobs`,
    });
  }
  if (info.memFragmentationRatio !== null && info.memFragmentationRatio > 1.5 && info.usedMemoryBytes > 100 * 1024 * 1024) {
    out.push({
      level: "warn",
      code: "fragmentation",
      message: `Memory fragmentation ratio ${info.memFragmentationRatio}`,
    });
  }
  if (info.persistenceOk === false) {
    out.push({ level: "critical", code: "persistence_failed", message: "Last background save or AOF write failed" });
  }
  if (info.rejectedConnections !== null && info.rejectedConnections > 0) {
    out.push({
      level: "warn",
      code: "rejected_connections",
      message: `${info.rejectedConnections.toLocaleString()} connections rejected (maxclients reached at some point)`,
    });
  }
  if (info.latencyMs >= 250) {
    out.push({ level: "warn", code: "latency_high", message: `INFO round trip took ${info.latencyMs} ms` });
  }
  return out;
}
