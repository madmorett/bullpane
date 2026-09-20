/**
 * Turning BullMQ's cumulative counters into "what happened in the last N minutes".
 *
 * WHY NOT ZCOUNT. The old implementation counted the `completed`/`failed` sorted
 * sets inside a trailing window. That only sees jobs that are STILL THERE, so a
 * queue with `removeOnComplete` reads as a queue that fails constantly. Measured
 * on a real Redis: 300 ok / 15 failed (4.8% real) reads as 50 ok / 15 failed
 * (23.1%) by ZCOUNT. A healthy queue would page someone at 3 a.m.
 *
 * WHAT WE DO INSTEAD. BullMQ increments `metrics:completed` field `count` (and
 * `metrics:failed`) as each job finishes; those counters never decrease and
 * pruning cannot touch them. So we sample them every tick and DIFF two samples:
 * the newest one and the oldest one still inside the configured window. The delta
 * is what actually finished in that stretch of time, whatever retention does.
 *
 * WINDOW vs TICK. The engine ticks every BULLPANE_ALERTS_INTERVAL seconds (15 s by
 * default); the user configures `windowMinutes` (1..1440). They do not line up,
 * so we keep a short ring buffer of samples per (alert, queue) and pick the
 * oldest sample at least `windowMinutes` old — that is the only way to report a
 * delta that matches the label on the screen. If no sample is that old yet
 * (fresh process, new alert, widened window), the measurement is INCONCLUSIVE
 * (`warming_up`): we refuse to extrapolate a 15 s delta into a 60 min claim.
 *
 * MEMORY. The buffer is capped in two directions: `MAX_SAMPLES` entries per
 * series and, because we drop everything older than the window plus one slack
 * tick, a 1-minute window keeps a handful of samples while a 24 h window keeps
 * at most MAX_SAMPLES. A server watching 500 queues therefore holds at most
 * 500 * MAX_SAMPLES tiny objects, bounded, no matter how long it runs.
 */
import type { AlertMeasurementState } from "@bullpane/shared";

/** One reading of the cumulative counters. */
export interface CounterSample {
  /** unix ms the reading was taken */
  t: number;
  /** cumulative completed; null when the queue collects no metrics */
  completed: number | null;
  /** cumulative failed; null when the queue collects no metrics */
  failed: number | null;
}

/**
 * Hard cap per series. 240 samples at the default 15 s tick is one hour of
 * history; longer windows are served by the coarse spacing rule below rather
 * than by keeping more samples, so RAM stays flat for a 24 h window.
 */
export const MAX_SAMPLES = 240;

/**
 * Minimum spacing between stored samples, as a fraction of the window. A 24 h
 * window does not need a sample every 15 s: one every ~6 min (1/240) is enough
 * to find an edge older than the window. The newest sample is always stored
 * (the delta's right edge must be current).
 */
function minSpacingMs(windowMs: number): number {
  return Math.floor(windowMs / MAX_SAMPLES);
}

export interface DeltaWindow {
  /** jobs completed between the two samples; null when inconclusive */
  completed: number | null;
  /** jobs failed between the two samples; null when inconclusive */
  failed: number | null;
  state: AlertMeasurementState;
  /** ms actually covered by the delta; null when inconclusive */
  windowCoveredMs: number | null;
}

const INCONCLUSIVE = (state: AlertMeasurementState): DeltaWindow => ({
  completed: null,
  failed: null,
  state,
  windowCoveredMs: null,
});

/**
 * A bounded history of counter readings for ONE (alert, connection, queue)
 * series. Everything here is pure and synchronous; the engine owns one instance
 * per series and the tests drive it directly.
 */
export class CounterHistory {
  private samples: CounterSample[] = [];

  /** for tests/introspection */
  get size(): number {
    return this.samples.length;
  }

  /**
   * Record a reading and return the delta over `windowMs`.
   *
   * Rules that keep the number honest:
   *  - metrics missing (both counters null) => `no_metrics`, history cleared so
   *    a queue that later enables metrics starts from a clean baseline instead
   *    of diffing against a stale one.
   *  - counter went DOWN (Redis restarted, queue obliterated, prefix reused) =>
   *    the series restarts at this sample; a negative delta is never reported.
   *  - no sample old enough => `warming_up`.
   */
  push(sample: CounterSample, windowMs: number): DeltaWindow {
    if (sample.completed === null && sample.failed === null) {
      this.samples = [];
      return INCONCLUSIVE("no_metrics");
    }

    const previous = this.samples[this.samples.length - 1];
    if (previous && wentBackwards(previous, sample)) {
      // Counters only ever grow. A drop means this is a different counter now,
      // so everything before it is meaningless.
      this.samples = [sample];
      return INCONCLUSIVE("warming_up");
    }

    this.append(sample, windowMs);

    const edge = this.oldestAtLeast(sample.t - windowMs);
    if (!edge) return INCONCLUSIVE("warming_up");

    return {
      completed: diff(edge.completed, sample.completed),
      failed: diff(edge.failed, sample.failed),
      state: "ok",
      windowCoveredMs: sample.t - edge.t,
    };
  }

  /**
   * Append the newest sample, then prune. Two rules, in this order:
   *
   * 1. DECIMATE. The newest sample is always appended (it is the delta's right
   *    edge and must be current), but the sample behind it is dropped when it
   *    sits closer than `minSpacingMs` to the one before it. So history is kept
   *    at roughly `windowMs / MAX_SAMPLES` resolution and the buffer's SPAN
   *    grows even though its length does not.
   *
   *    Both obvious alternatives are broken and were caught by the 24 h test:
   *    overwriting the tail caps the buffer at one entry (no edge, ever), and
   *    letting it fill to MAX_SAMPLES before trimming the oldest entries
   *    destroys the edge every tick — either way a long-window alert is stuck in
   *    warming_up forever and silently never fires.
   *
   * 2. FORGET what is older than the edge. Exactly one sample at or before
   *    `now - windowMs` is useful; anything before it is dead weight.
   */
  private append(sample: CounterSample, windowMs: number): void {
    this.samples.push(sample);

    const spacing = minSpacingMs(windowMs);
    const n = this.samples.length;
    if (spacing > 0 && n >= 3) {
      const prev = this.samples[n - 2] as CounterSample;
      const beforePrev = this.samples[n - 3] as CounterSample;
      // `prev` adds no resolution over `beforePrev`: drop it, keeping the span.
      if (prev.t - beforePrev.t < spacing) this.samples.splice(n - 2, 1);
    }

    // Everything older than the edge is dead weight: keep exactly one sample at
    // or before the cutoff (that IS the edge) and drop what precedes it.
    const cutoff = sample.t - windowMs;
    let keepFrom = 0;
    for (let i = 0; i < this.samples.length; i++) {
      const s = this.samples[i] as CounterSample;
      if (s.t <= cutoff) keepFrom = i;
      else break;
    }
    if (keepFrom > 0) this.samples = this.samples.slice(keepFrom);

    /**
     * Absolute backstop against a pathological input (window shrunk by an edit,
     * a clock jump, a tick far faster than 15 s). Dropping the oldest entries
     * would throw away the edge, so instead we thin the MIDDLE: keep the oldest
     * sample (the edge) and the newest (the current reading) and drop every
     * other one in between. The span survives, the length halves.
     */
    while (this.samples.length > MAX_SAMPLES) {
      const kept: CounterSample[] = [];
      for (let i = 0; i < this.samples.length; i++) {
        const isEnd = i === 0 || i === this.samples.length - 1;
        if (isEnd || i % 2 === 0) kept.push(this.samples[i] as CounterSample);
      }
      if (kept.length === this.samples.length) break; // cannot thin further
      this.samples = kept;
    }
  }

  /** The oldest sample at or before `at`, i.e. the far edge of the window. */
  private oldestAtLeast(at: number): CounterSample | undefined {
    for (const s of this.samples) if (s.t <= at) return s;
    return undefined;
  }
}

function wentBackwards(a: CounterSample, b: CounterSample): boolean {
  return (a.completed ?? 0) > (b.completed ?? 0) || (a.failed ?? 0) > (b.failed ?? 0);
}

/** null-safe non-negative difference. A one-sided null counts as 0 finished. */
function diff(from: number | null, to: number | null): number {
  const d = (to ?? 0) - (from ?? 0);
  return d > 0 ? d : 0;
}

/**
 * A keyed set of `CounterHistory`, one per (alert, connection, queue), with an
 * explicit ceiling so a server that has watched thousands of queues over weeks
 * cannot grow forever. Series untouched for `staleMs` are dropped (an alert was
 * deleted, a folder lost a queue, a queue disappeared).
 */
export class CounterHistoryStore {
  private readonly series = new Map<string, { history: CounterHistory; touchedAt: number }>();

  constructor(
    private readonly maxSeries = 5_000,
    private readonly staleMs = 6 * 3_600_000,
  ) {}

  get size(): number {
    return this.series.size;
  }

  /**
   * Composite key. The separator is a character that cannot appear in a nanoid
   * alert id nor in a connection id, so `dropAlert` can match by prefix without
   * a queue named like another alert's id colliding.
   */
  static readonly SEP = "\u0000";

  static key(alertId: string, connectionId: string, queueName: string): string {
    return [alertId, connectionId, queueName].join(CounterHistoryStore.SEP);
  }

  push(key: string, sample: CounterSample, windowMs: number): DeltaWindow {
    let entry = this.series.get(key);
    if (!entry) {
      this.evictIfNeeded(sample.t);
      entry = { history: new CounterHistory(), touchedAt: sample.t };
      this.series.set(key, entry);
    }
    entry.touchedAt = sample.t;
    return entry.history.push(sample, windowMs);
  }

  /** An alert was deleted or re-scoped: its history is meaningless. */
  drop(key: string): void {
    this.series.delete(key);
  }

  /** Drop every series of one alert (all its queues), by key prefix. */
  dropAlert(alertId: string): void {
    const prefix = alertId + CounterHistoryStore.SEP;
    for (const k of [...this.series.keys()]) if (k.startsWith(prefix)) this.series.delete(k);
  }

  private evictIfNeeded(now: number): void {
    if (this.series.size < this.maxSeries) return;
    for (const [k, v] of this.series) {
      if (now - v.touchedAt > this.staleMs) this.series.delete(k);
    }
    // Still full: drop the least recently touched to make room. Bounded memory
    // beats perfect history on a pathological install.
    while (this.series.size >= this.maxSeries) {
      let oldestKey: string | null = null;
      let oldestAt = Infinity;
      for (const [k, v] of this.series) {
        if (v.touchedAt < oldestAt) {
          oldestAt = v.touchedAt;
          oldestKey = k;
        }
      }
      if (oldestKey === null) return;
      this.series.delete(oldestKey);
    }
  }
}
