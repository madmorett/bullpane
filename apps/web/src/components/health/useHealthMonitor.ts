import { useCallback, useSyncExternalStore } from "react";
import type { ConnectionHealth } from "@bullpane/shared";
import { readStorage, writeStorage } from "@/lib/storage";
import { useConnectionsHealth } from "@/api/hooks";

/**
 * Whether the health monitor is allowed to talk to Redis.
 *
 * This is a module-level store, not React state, because the toggle lives on
 * the Overview panel but the TopBar summary and the /health page must obey it
 * too — someone pausing the monitor over a fragile production Redis expects
 * ALL of the dashboard's INFO traffic to stop, not just the widget they can see.
 */
const KEY = "health.paused";

let paused = readStorage<boolean>(KEY, false, (raw) => raw === "true" || raw === '"true"' || raw === "1");
const subs = new Set<() => void>();

function subscribe(fn: () => void): () => void {
  subs.add(fn);
  return () => subs.delete(fn);
}

function getSnapshot(): boolean {
  return paused;
}

export function setHealthPaused(next: boolean): void {
  if (paused === next) return;
  paused = next;
  writeStorage(KEY, next);
  subs.forEach((fn) => fn());
}

export function useHealthPaused(): [boolean, (next: boolean) => void] {
  const value = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const set = useCallback((next: boolean) => setHealthPaused(next), []);
  return [value, set];
}

export interface HealthMonitor {
  health: ConnectionHealth[];
  paused: boolean;
  setPaused: (next: boolean) => void;
  isLoading: boolean;
  /** the last error from the /health/connections call itself, not from Redis */
  error: unknown;
  /** newest sample time across all connections, unix ms, or null */
  lastSampleAt: number | null;
  refetch: () => void;
}

/** The one hook every health surface uses. Honours the global pause. */
export function useHealthMonitor(): HealthMonitor {
  const [paused, setPaused] = useHealthPaused();
  const query = useConnectionsHealth({ enabled: !paused });
  const health = query.data ?? [];

  let lastSampleAt: number | null = null;
  for (const h of health) {
    const t = h.info ? Date.parse(h.info.sampledAt) : NaN;
    if (Number.isFinite(t) && (lastSampleAt === null || t > lastSampleAt)) lastSampleAt = t;
  }

  return {
    health,
    paused,
    setPaused,
    isLoading: query.isLoading && !paused,
    error: query.error,
    lastSampleAt,
    refetch: () => void query.refetch(),
  };
}

export interface HealthAggregate {
  total: number;
  down: number;
  /** null when no connection has produced a rate yet — never render this as 0 */
  commandsPerSec: number | null;
  /** worst memory-used percentage across connections with a maxmemory set */
  memoryPct: number | null;
  /** busiest CPU across connections, in cores (1.0 = one saturated core); null until a rate exists */
  cpuCores: number | null;
  critical: number;
  warn: number;
}

export function aggregate(health: ConnectionHealth[]): HealthAggregate {
  let commandsPerSec: number | null = null;
  let memoryPct: number | null = null;
  let cpuCores: number | null = null;
  let down = 0;
  let critical = 0;
  let warn = 0;

  for (const h of health) {
    if (!h.ok) down++;
    if (h.commandsPerSec != null) commandsPerSec = (commandsPerSec ?? 0) + h.commandsPerSec;
    if (h.memoryUsedPct != null) memoryPct = Math.max(memoryPct ?? 0, h.memoryUsedPct);
    // The busiest single Redis, not a sum: CPU across separate servers does not add up.
    if (h.cpuCores != null) cpuCores = Math.max(cpuCores ?? 0, h.cpuCores);
    for (const w of h.warnings) {
      if (w.level === "critical") critical++;
      else warn++;
    }
  }

  return { total: health.length, down, commandsPerSec, memoryPct, cpuCores, critical, warn };
}
