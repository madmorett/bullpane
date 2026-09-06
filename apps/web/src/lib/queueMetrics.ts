import type { JobSummary, QueueMetrics } from "@bullmq-visualizer/shared";

/**
 * Everything derivable from what the server already sends. Nothing here
 * invents a number: if BullMQ does not store it, the function returns null
 * and the UI says so.
 */

export const METRIC_RANGES = [15, 30, 60, 0] as const;
export type MetricRange = (typeof METRIC_RANGES)[number];

export const RANGE_LABEL: Record<MetricRange, string> = {
  15: "15 min",
  30: "30 min",
  60: "1 hour",
  0: "All",
};

/** true when the queue collects nothing at all — no arrays, or arrays of zeros. */
export function hasMetrics(metrics: QueueMetrics | undefined): metrics is QueueMetrics {
  if (!metrics) return false;
  const total = sum(metrics.completed) + sum(metrics.failed);
  return (metrics.completed.length > 0 || metrics.failed.length > 0) && total > 0;
}

export interface SlicedMetrics {
  completed: number[];
  failed: number[];
  /** minutes actually returned */
  minutes: number;
  /** how many minutes the queue stores in total */
  available: number;
  /** the requested range was longer than what BullMQ has kept */
  truncated: boolean;
}

/**
 * Take the tail of the per-minute arrays. BullMQ keeps one point per minute up
 * to the worker's `maxDataPoints`, so the array length IS the hard limit — a
 * 1-hour request against a 20-minute array returns 20 minutes and says so.
 */
export function sliceMetrics(metrics: QueueMetrics | undefined, range: MetricRange): SlicedMetrics {
  const completed = metrics?.completed ?? [];
  const failed = metrics?.failed ?? [];
  const available = Math.max(completed.length, failed.length);
  const want = range === 0 ? available : range;
  const take = Math.min(want, available);
  const tail = (arr: number[]) => {
    const padded = padTo(arr, available);
    return padded.slice(available - take);
  };
  return {
    completed: tail(completed),
    failed: tail(failed),
    minutes: take,
    available,
    truncated: range !== 0 && range > available,
  };
}

/** the two arrays can in principle differ in length; align them on the right */
function padTo(arr: number[], len: number): number[] {
  if (arr.length >= len) return arr;
  return [...Array.from({ length: len - arr.length }, () => 0), ...arr];
}

export interface Throughput {
  /** mean completed jobs per minute over the slice */
  perMinute: number | null;
  /** the same rate expressed per hour — NOT a count of the last hour */
  perHour: number | null;
  completed: number;
  failed: number;
  /** completed / (completed + failed) across the slice, null when nothing finished */
  successPct: number | null;
}

export function throughput(s: SlicedMetrics): Throughput {
  if (s.minutes === 0) return { perMinute: null, perHour: null, completed: 0, failed: 0, successPct: null };
  const completed = sum(s.completed);
  const failed = sum(s.failed);
  const finished = completed + failed;
  const perMinute = completed / s.minutes;
  return {
    perMinute,
    perHour: perMinute * 60,
    completed,
    failed,
    successPct: finished > 0 ? (completed / finished) * 100 : null,
  };
}

/** per-minute success rate; a minute with no finished job is a HOLE, not 0 %. */
export function successSeries(s: SlicedMetrics): (number | null)[] {
  return s.completed.map((c, i) => {
    const f = s.failed[i] ?? 0;
    const finished = c + f;
    return finished > 0 ? (c / finished) * 100 : null;
  });
}

/** element-wise sum of several per-minute arrays, right-aligned. Shorter arrays contribute zeros. */
export function sumSeries(arrays: (number[] | undefined)[]): number[] {
  const present = arrays.filter((a): a is number[] => !!a && a.length > 0);
  if (present.length === 0) return [];
  const len = Math.max(...present.map((a) => a.length));
  const out = new Array<number>(len).fill(0);
  for (const arr of present) {
    const offset = len - arr.length;
    for (let i = 0; i < arr.length; i++) out[offset + i] += arr[i];
  }
  return out;
}

export function sum(arr: number[] | undefined): number {
  return (arr ?? []).reduce((a, b) => a + b, 0);
}

// ---------------------------------------------------------------------------
// Latency sample from loaded jobs
// ---------------------------------------------------------------------------

export interface DurationStats {
  min: number;
  median: number;
  p95: number;
  max: number;
  /** how many jobs contributed */
  count: number;
}

export interface LatencySample {
  /** processedOn - timestamp: how long the job sat in the queue */
  wait: DurationStats | null;
  /** finishedOn - processedOn: how long the worker took */
  process: DurationStats | null;
  /** jobs inspected (the page size, not the queue size) */
  sampled: number;
}

/**
 * Response/process time from a page of completed jobs.
 *
 * BullMQ stores NO aggregate timing anywhere in Redis — no histogram, no
 * rolling min/median/max. The only honest source is the per-job timestamps on
 * jobs we already loaded, which makes this a SAMPLE of one page, not a
 * server-wide statistic. Every caller must label it that way.
 */
export function latencySample(jobs: JobSummary[] | undefined): LatencySample {
  const list = jobs ?? [];
  const wait: number[] = [];
  const process: number[] = [];
  for (const j of list) {
    if (j.processedOn != null && j.timestamp != null) {
      const d = j.processedOn - j.timestamp;
      if (Number.isFinite(d) && d >= 0) wait.push(d);
    }
    if (j.finishedOn != null && j.processedOn != null) {
      const d = j.finishedOn - j.processedOn;
      if (Number.isFinite(d) && d >= 0) process.push(d);
    }
  }
  return { wait: stats(wait), process: stats(process), sampled: list.length };
}

export function stats(values: number[]): DurationStats | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  return {
    min: s[0],
    median: percentile(s, 50),
    p95: percentile(s, 95),
    max: s[s.length - 1],
    count: s.length,
  };
}

/** nearest-rank percentile over an already-sorted array */
function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))];
}
