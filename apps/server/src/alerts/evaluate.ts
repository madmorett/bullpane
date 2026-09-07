/**
 * Pure alert logic: turn a measurement into a sample, and a sample + the
 * alert's current state into a decision. No I/O, fully unit tested.
 */
import type { AlertCondition, AlertKind, AlertMeasurementState } from "@bullpane/shared";

/**
 * What the engine could observe for one queue.
 *
 * `waiting_above` is a GAUGE: the backlog right now, read from the state counts.
 * The error kinds are RATES: `failed`/`completed` are DELTAS over the alert's
 * window, produced by diffing BullMQ's cumulative metrics counters between two
 * ticks (see metricsWindow.ts). `null` there means the delta could not be
 * computed — no metrics on the queue, or not enough history yet — and `state`
 * says which. Never pass 0 for "unknown": 0 failures looks perfectly healthy.
 */
export type Measurement =
  | { kind: "waiting_above"; waiting: number }
  | { kind: "failed_above"; failed: number | null; state: AlertMeasurementState }
  | { kind: "failed_rate_above"; failed: number | null; completed: number | null; state: AlertMeasurementState };

export interface Sample {
  /** null = not enough data to judge (e.g. below minSample); leaves state untouched */
  breached: boolean | null;
  value: number | null;
  threshold: number | null;
  unit: "jobs" | "%" | null;
  /**
   * Why a null `breached` is null. "ok" with a null breached means the data was
   * there but too thin to judge (below minSample). The UI shows this instead of
   * a green badge, so an inert alert is visible.
   */
  state: AlertMeasurementState;
}

export type AlertAction = "none" | "fire" | "renotify" | "resolve";

export interface AlertStateInput {
  firing: boolean;
  lastFiredAt: Date | number | null;
  cooldownMinutes: number;
}

export interface AlertDecision {
  action: AlertAction;
  firing: boolean;
  /** unix ms */
  lastFiredAt: number | null;
}

export function measure(condition: AlertCondition, m: Measurement): Sample {
  if (condition.kind !== m.kind) {
    throw new Error(`measurement kind ${m.kind} does not match condition ${condition.kind}`);
  }
  switch (condition.kind) {
    case "waiting_above": {
      const waiting = (m as Extract<Measurement, { kind: "waiting_above" }>).waiting;
      return { breached: waiting > condition.threshold, value: waiting, threshold: condition.threshold, unit: "jobs", state: "ok" };
    }
    case "failed_above": {
      const { failed, state } = m as Extract<Measurement, { kind: "failed_above" }>;
      // No delta => nothing to compare against. Refuse to judge rather than
      // report 0 (healthy) or a partial-window number (a lie in both directions).
      if (failed === null || state !== "ok") {
        return { breached: null, value: null, threshold: condition.threshold, unit: "jobs", state };
      }
      return { breached: failed > condition.threshold, value: failed, threshold: condition.threshold, unit: "jobs", state: "ok" };
    }
    case "failed_rate_above": {
      const { failed, completed, state } = m as Extract<Measurement, { kind: "failed_rate_above" }>;
      if (failed === null || completed === null || state !== "ok") {
        return { breached: null, value: null, threshold: condition.percent, unit: "%", state };
      }
      const total = failed + completed;
      if (total < condition.minSample) {
        // Enough history, just not enough traffic: the source is fine, the
        // window is simply too quiet to make a percentage mean anything.
        return { breached: null, value: null, threshold: condition.percent, unit: "%", state: "ok" };
      }
      const rate = Math.round((failed / total) * 10000) / 100;
      return { breached: rate > condition.percent, value: rate, threshold: condition.percent, unit: "%", state: "ok" };
    }
  }
}

function toMs(v: Date | number | null): number | null {
  if (v === null) return null;
  return v instanceof Date ? v.getTime() : v;
}

/**
 * State machine:
 *   not firing + breached      → fire
 *   firing + breached          → renotify once cooldown has elapsed, else none
 *   firing + not breached      → resolve
 *   not firing + not breached  → none
 *   breached === null          → none (keep state)
 */
export function evaluateAlert(alert: AlertStateInput, sample: Pick<Sample, "breached">, now: number): AlertDecision {
  const lastFiredAt = toMs(alert.lastFiredAt);
  if (sample.breached === null) return { action: "none", firing: alert.firing, lastFiredAt };

  if (!alert.firing) {
    return sample.breached ? { action: "fire", firing: true, lastFiredAt: now } : { action: "none", firing: false, lastFiredAt };
  }
  if (!sample.breached) return { action: "resolve", firing: false, lastFiredAt };

  const cooldownMs = alert.cooldownMinutes * 60_000;
  if (lastFiredAt === null || now - lastFiredAt >= cooldownMs) {
    return { action: "renotify", firing: true, lastFiredAt: now };
  }
  return { action: "none", firing: true, lastFiredAt };
}

export function formatValue(sample: Pick<Sample, "value" | "unit">): string {
  if (sample.value === null) return "n/a";
  return sample.unit === "%" ? `${sample.value}%` : String(sample.value);
}

export function describeCondition(condition: AlertCondition): string {
  switch (condition.kind) {
    case "waiting_above":
      // Says exactly what is counted: wait + prioritized. `paused` is excluded
      // because pausing a queue for maintenance is intentional, not a backlog
      // incident (see engine.ts).
      return `waiting jobs (incl. prioritized, excl. paused) above ${condition.threshold}`;
    case "failed_above":
      return `more than ${condition.threshold} failed jobs in ${condition.windowMinutes} min`;
    case "failed_rate_above":
      return `failure rate above ${condition.percent}% over ${condition.windowMinutes} min (min sample ${condition.minSample})`;
  }
}

export function formatMessage(input: {
  kind: AlertKind;
  condition: AlertCondition;
  status: "fired" | "resolved" | "test";
  /** the queue being reported (worst queue for folder alerts) */
  queueName: string | null;
  connectionName: string | null;
  /** set for folder-scoped alerts */
  folderName?: string | null;
  sample: Sample;
}): string {
  const queue = input.queueName ? `queue "${input.queueName}"` : "queue";
  const on = input.connectionName ? ` on ${input.connectionName}` : "";
  const folder = input.folderName ? ` (folder "${input.folderName}")` : "";
  const scope = `${queue}${on}${folder}`;
  if (input.status === "test") {
    const target = input.folderName ? `folder "${input.folderName}"` : scope;
    return `Test notification for ${target}: ${describeCondition(input.condition)}.`;
  }
  const value = formatValue(input.sample);
  const threshold = input.sample.threshold === null ? "" : ` (threshold ${input.sample.threshold}${input.sample.unit === "%" ? "%" : ""})`;
  return input.status === "fired"
    ? `${scope}: ${describeCondition(input.condition)} — current ${value}${threshold}.`
    : `${scope}: back below threshold — current ${value}${threshold}.`;
}
