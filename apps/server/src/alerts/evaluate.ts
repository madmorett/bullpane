/**
 * Pure alert logic: turn a measurement into a sample, and a sample + the
 * alert's current state into a decision. No I/O, fully unit tested.
 */
import type { AlertCondition, AlertKind } from "@bullmq-visualizer/shared";

export type Measurement =
  | { kind: "waiting_above"; waiting: number }
  | { kind: "failed_above"; failed: number }
  | { kind: "failed_rate_above"; failed: number; completed: number };

export interface Sample {
  /** null = not enough data to judge (e.g. below minSample); leaves state untouched */
  breached: boolean | null;
  value: number | null;
  threshold: number | null;
  unit: "jobs" | "%" | null;
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
      return { breached: waiting > condition.threshold, value: waiting, threshold: condition.threshold, unit: "jobs" };
    }
    case "failed_above": {
      const failed = (m as Extract<Measurement, { kind: "failed_above" }>).failed;
      return { breached: failed > condition.threshold, value: failed, threshold: condition.threshold, unit: "jobs" };
    }
    case "failed_rate_above": {
      const { failed, completed } = m as Extract<Measurement, { kind: "failed_rate_above" }>;
      const total = failed + completed;
      if (total < condition.minSample) {
        return { breached: null, value: null, threshold: condition.percent, unit: "%" };
      }
      const rate = Math.round((failed / total) * 10000) / 100;
      return { breached: rate > condition.percent, value: rate, threshold: condition.percent, unit: "%" };
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
      return `waiting jobs above ${condition.threshold}`;
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
