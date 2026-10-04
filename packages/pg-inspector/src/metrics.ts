/**
 * Rates and processing-time percentiles from BullMQ's `metrics` table.
 *
 * BullMQ's Postgres backend keeps metrics exactly like Redis does (see
 * collect_metrics in its 0002_functions.sql): per queue and side (completed /
 * failed) a cumulative `count`, `prev_ts` / `prev_count`, and `data`, the
 * per-minute deltas newest first, flushed when a job finishes in a later minute.
 * So this is a direct port of redis-inspector's lua/windowMetrics.lua, and that
 * file's header is the explanation of the arithmetic.
 */
import type { QueueRates } from "@bullpane/shared";
import type { WindowMetrics, WindowMetricsRequest } from "@bullpane/inspector";
import { num, numOrNull } from "./rows.js";

export interface MetricsRow {
  kind: string;
  count: number | string;
  prevTs: number | string | null;
  prevCount: number | string | null;
  /** newest first */
  data: Array<number | string> | null;
}

type SideReader = (windowMinutes: number) => { total: number; covered: number };

function side(row: MetricsRow | undefined, nowMin: number): { has: boolean; read: SideReader } {
  if (!row) {
    // Absent row: normal for `failed` on a queue that never failed. Reads as
    // zero, fully covered; "no metrics" is decided from BOTH sides being absent.
    return { has: false, read: (w) => ({ total: 0, covered: w }) };
  }
  const count = num(row.count);
  const prevTs = numOrNull(row.prevTs);
  if (prevTs === null) return { has: true, read: (w) => ({ total: count, covered: w }) };
  const m0 = Math.floor(prevTs / 60_000);
  const ref = Math.max(nowMin, m0); // a worker clock ahead of ours
  const pending = count - num(row.prevCount);
  const points = (row.data ?? []).map((v) => num(v));
  return {
    has: true,
    read: (w) => {
      const startMin = ref - w + 1;
      if (m0 < startMin) return { total: 0, covered: w }; // nothing finished inside the window
      const n = Math.min(m0 - startMin, points.length);
      let total = pending;
      for (let i = 0; i < n; i += 1) total += points[i] ?? 0;
      return { total, covered: Math.min(ref - m0 + 1 + n, w) };
    },
  };
}

function percentile(sorted: number[], q: number): number {
  const idx = Math.max(1, Math.ceil((q / 100) * sorted.length));
  return sorted[idx - 1] ?? -1;
}

export function windowMetricsFrom(
  request: WindowMetricsRequest,
  rows: MetricsRow[] | null,
  /** [finishedAt, durationMs] newest first */
  durations: Array<[number | string, number | string]> | null,
  now: number,
): WindowMetrics {
  const nowMin = Math.floor(now / 60_000);
  const completed = side(rows?.find((r) => r.kind === "completed"), nowMin);
  const failed = side(rows?.find((r) => r.kind === "failed"), nowMin);
  const sampled = (durations ?? []).map(([f, d]) => [num(f), num(d)] as const);
  return {
    hasMetrics: completed.has || failed.has,
    rates: request.rateWindows.map((windowMinutes) => {
      const c = completed.read(windowMinutes);
      const f = failed.read(windowMinutes);
      return { windowMinutes, completed: c.total, failed: f.total, coveredMinutes: Math.min(c.covered, f.covered) };
    }),
    durations: request.durationWindows.map((windowMinutes) => {
      const since = now - windowMinutes * 60_000;
      const ds = sampled.filter(([f]) => f >= since).map(([, d]) => d).sort((a, b) => a - b);
      return {
        windowMinutes,
        sampled: ds.length,
        p50Ms: ds.length > 0 ? percentile(ds, 50) : null,
        p95Ms: ds.length > 0 ? percentile(ds, 95) : null,
      };
    }),
    collectedAt: now,
  };
}

/**
 * Success rate over a trailing window: the same rules as the Redis inspector's
 * parseStats. BullMQ's metrics when the Worker collects them (prune-proof);
 * otherwise a count of the finished jobs still stored, flagged as skewed when the
 * queue prunes completed jobs and there are failures to unbalance the ratio.
 */
export function ratesFrom(input: {
  windowMinutes: number;
  /** oldest first */
  metricsCompleted: number[];
  metricsFailed: number[];
  totalCompleted: number | null;
  totalFailed: number | null;
  storedCompleted: number;
  storedFailed: number;
  prunesCompleted: boolean;
}): QueueRates {
  const pct = (c: number, f: number) => (c + f === 0 ? null : Math.round((c / (c + f)) * 1000) / 10);
  if (input.totalCompleted !== null || input.totalFailed !== null) {
    const points = Math.min(input.windowMinutes, Math.max(input.metricsCompleted.length, input.metricsFailed.length));
    const sum = (xs: number[]) => xs.slice(-points).reduce((a, b) => a + b, 0);
    const completed = points > 0 ? sum(input.metricsCompleted) : (input.totalCompleted ?? 0);
    const failed = points > 0 ? sum(input.metricsFailed) : (input.totalFailed ?? 0);
    return {
      windowMinutes: points > 0 ? points : 0,
      completed,
      failed,
      successPct: pct(completed, failed),
      source: "metrics",
      retentionSkewed: false,
    };
  }
  return {
    windowMinutes: input.windowMinutes,
    completed: input.storedCompleted,
    failed: input.storedFailed,
    successPct: pct(input.storedCompleted, input.storedFailed),
    // QueueRates calls this source "zset" (the Redis name); here it is a COUNT of stored rows.
    source: "zset",
    retentionSkewed: input.prunesCompleted && input.storedFailed > 0,
  };
}
