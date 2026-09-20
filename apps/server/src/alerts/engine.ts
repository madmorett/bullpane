/**
 * Alert evaluation loop. Runs every BULLPANE_ALERTS_INTERVAL seconds while the
 * edition is pro (a license or DEMO_MODE). One ping and one getQueueStats per
 * connection per tick, shared by every alert on that connection.
 *
 * HOW ERROR ALERTS MEASURE (the whole point of this file)
 *
 * `failed_above` and `failed_rate_above` are measured ONLY from BullMQ's own
 * cumulative metrics counters, sampled each tick and diffed against the oldest
 * sample still inside the alert's window (see metricsWindow.ts). ZCOUNT over the
 * completed/failed zsets — what this used to do — counts only jobs that are
 * still in Redis, so any queue using `removeOnComplete` reports a wildly
 * inflated failure rate (measured: 4.8% real read as 23.1%). There is
 * deliberately NO fallback: a queue whose Worker does not collect metrics gets
 * NO error alert, and one informative event says so. An absent alert is a known
 * gap; a lying alert destroys trust in every other alert.
 *
 * `waiting_above` is a gauge, not a rate, so it still comes straight from the
 * state counts.
 */
import type { Alert, AlertCondition, AlertMeasurement, FolderQueueRef } from "@bullpane/shared";
import { isErrorAlertKind } from "@bullpane/shared";
import type { Inspector, MetricsCounters, QueueStats } from "@bullpane/redis-inspector";
import type { Config } from "../config";
import type { AlertRow, ConnectionRow } from "../db/schema";
import type { AlertsService } from "../services/alerts";
import type { ConnectionsService } from "../services/connections";
import type { EditionService } from "../services/edition";
import type { FoldersService } from "../services/folders";
import { mapWithConcurrency } from "../services/flows";
import { alertLink, deliverToAll, type DeliveryResult, type FetchLike } from "./deliver";
import { describeCondition, evaluateAlert, formatMessage, measure, type Measurement, type Sample } from "./evaluate";
import { CounterHistoryStore } from "./metricsWindow";
import { scopeOf, toAlertDto } from "../services/alerts";

export interface EngineLogger {
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
  error(obj: object, msg: string): void;
  debug(obj: object, msg: string): void;
}

interface TickCache {
  connections: Map<string, Promise<ConnectionRow | null>>;
  stats: Map<string, Promise<{ names: string[]; stats: Record<string, QueueStats> }>>;
  singleStats: Map<string, Promise<QueueStats | undefined>>;
  /** cumulative metrics counters, one read per (connection, queue) per tick */
  counters: Map<string, Promise<MetricsCounters>>;
}

/** One queue an alert watches. */
export type Target = FolderQueueRef;

interface Measured {
  sample: Sample;
  /** the queue the reported value belongs to (worst queue for folder alerts); null when inconclusive */
  target: Target | null;
  /** what the evaluation could actually see, surfaced on the Alert DTO and events */
  measurement: AlertMeasurement;
}

interface ResolvedScope {
  targets: Target[];
  folderName: string | null;
}

const EVENT_RETENTION_DAYS = 30;

export class AlertsEngine {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private ticks = 0;
  /**
   * Counter history per (alert, connection, queue). In memory on purpose: it is
   * a sliding window of a few hundred integers, worthless after a restart, and
   * not worth a MySQL write every 15 s. A restart therefore means
   * "accumulating history" (warming_up), never "zero failures".
   */
  private readonly history = new CounterHistoryStore();
  /** last measurement state per alert, so the DTO can show it and the UI stop lying */
  private readonly lastMeasurement = new Map<string, AlertMeasurement>();
  /**
   * When we last told the owner that an alert cannot measure, per alert. Rate
   * limited to the alert's own cooldown so the events table does not get one
   * row every 15 s forever.
   */
  private readonly noticedAt = new Map<string, number>();

  constructor(
    private readonly deps: {
      config: Config;
      alerts: AlertsService;
      connections: ConnectionsService;
      folders: FoldersService;
      edition: EditionService;
      log: EngineLogger;
      fetch?: FetchLike;
    },
  ) {}

  start(): void {
    if (this.timer) return;
    const everyMs = this.deps.config.alertsInterval * 1000;
    this.timer = setInterval(() => void this.tick(), everyMs);
    this.timer.unref();
    this.deps.log.info({ intervalSec: this.deps.config.alertsInterval }, "alerts engine started");
    void this.tick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * What the last tick could see for this alert, for GET /alerts. `undefined`
   * before the first tick (or when alerts are locked), which the UI shows as
   * "not evaluated yet" rather than as a green "ok".
   */
  measurementOf(alertId: string): AlertMeasurement | undefined {
    return this.lastMeasurement.get(alertId);
  }

  /** An alert was deleted or re-scoped: its history and notices are meaningless. */
  forget(alertId: string): void {
    this.lastMeasurement.delete(alertId);
    this.noticedAt.delete(alertId);
    this.history.dropAlert(alertId);
  }

  async tick(): Promise<void> {
    if (this.running) return;
    if (!this.deps.edition.getEdition().features.alerts) return;
    this.running = true;
    const startedAt = Date.now();
    try {
      const rows = await this.deps.alerts.listRows({ enabledOnly: true });
      if (rows.length > 0) {
        const cache = newCache();
        await Promise.all(
          rows.map((row) =>
            this.evaluateOne(row, cache, startedAt).catch((err: unknown) =>
              this.deps.log.warn({ alertId: row.id, err: errorText(err) }, "alert evaluation failed"),
            ),
          ),
        );
      }
      this.ticks += 1;
      if (this.ticks % 240 === 1) {
        await this.deps.alerts.pruneEvents(new Date(startedAt - EVENT_RETENTION_DAYS * 86_400_000));
      }
    } catch (err) {
      this.deps.log.error({ err: errorText(err) }, "alerts tick failed");
    } finally {
      this.running = false;
    }
  }

  /** POST /alerts/:id/test — synthetic event to every channel. */
  async sendTest(row: AlertRow): Promise<DeliveryResult[]> {
    const scope = await this.resolveScope(row);
    const first = scope.targets[0] ?? null;
    const connection = first ? await this.deps.connections.getRow(first.connectionId).catch(() => null) : null;
    const alert = toAlertDto(row);
    const sample: Sample = { breached: true, value: null, threshold: thresholdOf(row.condition), unit: null, state: "ok" };
    const message = formatMessage({
      kind: row.condition.kind,
      condition: row.condition,
      status: "test",
      queueName: first?.queueName ?? null,
      connectionName: connection?.name ?? null,
      folderName: scope.folderName,
      sample,
    });
    return deliverToAll(
      row.channels,
      {
        alert,
        status: "test",
        message,
        value: null,
        threshold: sample.threshold,
        queueName: first?.queueName ?? null,
        connectionName: connection?.name ?? null,
        folderName: scope.folderName,
        url: alertLink(this.deps.config.publicUrl, first?.connectionId ?? null, first?.queueName ?? null),
      },
      this.deps.fetch,
    );
  }

  /** Queue alert → that queue. Folder alert → every queue in the folder (any connection). */
  private async resolveScope(row: AlertRow): Promise<ResolvedScope> {
    const scope = scopeOf(row);
    if (scope.type === "queue") {
      return { targets: [{ connectionId: scope.connectionId, queueName: scope.queueName }], folderName: null };
    }
    const folder = await this.deps.folders.get(scope.folderId);
    return { targets: folder.queues, folderName: folder.name };
  }

  private async evaluateOne(row: AlertRow, cache: TickCache, now: number): Promise<void> {
    const scope = await this.resolveScope(row).catch(() => null);
    if (!scope) {
      this.deps.log.warn({ alertId: row.id }, "alert points to a missing folder");
      return;
    }
    if (scope.targets.length === 0) return; // empty folder: nothing to watch

    const measured = await this.measure(row, scope.targets, cache);
    if (!measured) return; // Redis unreachable: keep state, try next tick

    this.lastMeasurement.set(row.id, measured.measurement);

    // An alert that cannot measure is worse than no alert only if it is silent.
    // Tell the owner once (per cooldown), then stay quiet.
    if (measured.measurement.state === "no_metrics") {
      await this.noticeNoMetrics(row, scope, measured.measurement, cache, now);
      return; // never fire, never resolve: we know nothing about this queue
    }

    const decision = evaluateAlert(
      { firing: row.firing, lastFiredAt: row.lastFiredAt, cooldownMinutes: row.cooldownMinutes },
      measured.sample,
      now,
    );
    if (decision.action === "none") return;

    const status = decision.action === "resolve" ? "resolved" : "fired";
    const target = measured.target ?? scope.targets[0] ?? null;
    const connection = target ? await this.connection(target.connectionId, cache) : null;
    const queueName = target?.queueName ?? null;
    const connectionId = target?.connectionId ?? null;
    const message = formatMessage({
      kind: row.condition.kind,
      condition: row.condition,
      status,
      queueName,
      connectionName: connection?.name ?? null,
      folderName: scope.folderName,
      sample: measured.sample,
    });

    await this.deps.alerts.setState(row.id, {
      firing: decision.firing,
      lastFiredAt: decision.lastFiredAt === null ? null : new Date(decision.lastFiredAt),
    });
    await this.deps.alerts.recordEvent({
      alertId: row.id,
      alertName: row.name,
      connectionId,
      queueName,
      kind: row.condition.kind,
      status,
      message,
      value: measured.sample.value,
    });
    this.deps.log.info({ alertId: row.id, action: decision.action, value: measured.sample.value }, message);

    const alert: Alert = toAlertDto(row);
    const results = await deliverToAll(
      row.channels,
      {
        alert,
        status,
        message,
        value: measured.sample.value,
        threshold: measured.sample.threshold,
        queueName,
        connectionName: connection?.name ?? null,
        folderName: scope.folderName,
        url: alertLink(this.deps.config.publicUrl, connectionId, queueName),
      },
      this.deps.fetch,
    );
    for (const r of results) {
      if (r.ok) continue;
      await this.deps.alerts.recordEvent({
        alertId: row.id,
        alertName: row.name,
        connectionId,
        queueName,
        kind: row.condition.kind,
        status: "delivery_failed",
        message: `Delivery to ${r.channel} failed: ${r.error ?? "unknown error"}`,
        value: measured.sample.value,
      });
      this.deps.log.warn({ alertId: row.id, channel: r.channel, error: r.error }, "alert delivery failed");
    }
  }

  private connection(id: string, cache: TickCache): Promise<ConnectionRow | null> {
    let p = cache.connections.get(id);
    if (!p) {
      p = this.deps.connections.getRow(id).catch(() => null);
      cache.connections.set(id, p);
    }
    return p;
  }

  /** One discovery + one pipelined stats call per connection per tick. */
  private allStats(inspector: Inspector, cache: TickCache): Promise<{ names: string[]; stats: Record<string, QueueStats> }> {
    let p = cache.stats.get(inspector.config.id);
    if (!p) {
      p = (async () => {
        const names = await inspector.discoverQueues();
        const stats = names.length ? await inspector.getQueueStats(names) : {};
        return { names, stats };
      })();
      cache.stats.set(inspector.config.id, p);
    }
    return p;
  }

  private async queueStats(inspector: Inspector, queue: string, cache: TickCache): Promise<QueueStats | undefined> {
    const all = await this.allStats(inspector, cache);
    if (all.stats[queue]) return all.stats[queue];
    // Not discovered (filtered out or brand new): one direct call, still shared per tick.
    const key = `${inspector.config.id}:${queue}`;
    let p = cache.singleStats.get(key);
    if (!p) {
      p = inspector.getQueueStats([queue]).then((s) => s[queue]);
      cache.singleStats.set(key, p);
    }
    return p;
  }

  /** One HGET pair per (connection, queue) per tick, shared by every alert on it. */
  private metricsCounters(inspector: Inspector, queue: string, cache: TickCache): Promise<MetricsCounters> {
    const key = `${inspector.config.id}:${queue}`;
    let p = cache.counters.get(key);
    if (!p) {
      p = inspector.getMetricsCounters(queue);
      cache.counters.set(key, p);
    }
    return p;
  }

  /**
   * Record ONE informative event saying the alert is inert because the queue
   * collects no metrics, and how to fix it. Re-armed after the alert's own
   * cooldown so a permanently misconfigured queue produces a reminder now and
   * then instead of 5.760 rows a day. No notification is delivered: this is a
   * configuration problem for whoever reads the dashboard, not an incident.
   */
  private async noticeNoMetrics(
    row: AlertRow,
    scope: ResolvedScope,
    measurement: AlertMeasurement,
    cache: TickCache,
    now: number,
  ): Promise<void> {
    const last = this.noticedAt.get(row.id);
    const cooldownMs = row.cooldownMinutes * 60_000;
    if (last !== undefined && now - last < cooldownMs) return;
    this.noticedAt.set(row.id, now);

    const target = scope.targets[0] ?? null;
    const connection = target ? await this.connection(target.connectionId, cache) : null;
    const named = measurement.queuesWithoutMetrics ?? [];
    const which =
      scope.folderName !== null
        ? `folder "${scope.folderName}" — ${named.length > 0 ? `no metrics on: ${named.join(", ")}` : "no queue collects metrics"}`
        : `queue "${target?.queueName ?? "?"}"`;
    const message =
      `Cannot measure ${describeCondition(row.condition)} on ${which}: BullMQ keeps no metrics counters for it, ` +
      `so failure counts would have to come from the completed/failed sorted sets — which lie whenever removeOnComplete prunes them. ` +
      `This alert is inert until metrics are on. Fix: new Worker(name, fn, { metrics: { maxDataPoints: MetricsTime.ONE_WEEK } }).`;

    await this.deps.alerts.recordEvent({
      alertId: row.id,
      alertName: row.name,
      connectionId: target?.connectionId ?? null,
      queueName: scope.folderName !== null ? null : target?.queueName ?? null,
      kind: row.condition.kind,
      status: "no_metrics",
      message,
      value: null,
    });
    this.deps.log.warn(
      { alertId: row.id, connectionName: connection?.name ?? null, queues: named },
      "alert cannot measure: queue collects no BullMQ metrics",
    );
  }

  /**
   * Measure every target queue (grouped by connection so each connection gets ONE
   * discovery + ONE stats pipeline per tick) and report the worst one.
   *
   * `waiting_above` reads the state counts (a gauge). The error kinds read
   * BullMQ's cumulative metrics counters and diff them against this alert's own
   * history for that queue, so the number reported is the delta over
   * `windowMinutes` and nothing else.
   */
  private async measure(row: AlertRow, targets: Target[], cache: TickCache): Promise<Measured | null> {
    const condition = row.condition;
    const windowMs = "windowMinutes" in condition ? condition.windowMinutes * 60_000 : 0;
    const noMetrics: string[] = [];
    let coveredMs: number | null = null;
    try {
      const measurements = await mapWithConcurrency(targets, 5, async (target): Promise<Measurement | null> => {
        const connection = await this.connection(target.connectionId, cache);
        if (!connection) return null;
        const inspector = this.deps.connections.inspectorFor(connection);
        const queue = target.queueName;
        switch (condition.kind) {
          case "waiting_above": {
            const s = await this.queueStats(inspector, queue, cache);
            const counts = s?.counts;
            /**
             * Backlog = `wait` + `prioritized`.
             *
             * `prioritized` stays in: those jobs are queued work waiting for a
             * worker, exactly like `wait`. `paused` is deliberately EXCLUDED:
             * when an operator pauses a queue every waiting job moves into the
             * `paused` list, so including it meant pausing a queue for
             * maintenance instantly fired a "backlog!" alert — punishing the
             * correct operational move. A paused queue's real problem is that it
             * is paused, which the dashboard already shows.
             */
            const waiting = counts ? counts.waiting + counts.prioritized : 0;
            return { kind: "waiting_above", waiting };
          }
          case "failed_above":
          case "failed_rate_above": {
            const counters = await this.metricsCounters(inspector, queue, cache);
            // History is per (alert, connection, queue): two alerts with
            // different windows on the same queue must not share a buffer.
            const delta = this.history.push(
              CounterHistoryStore.key(row.id, target.connectionId, queue),
              { t: counters.collectedAt, completed: counters.completed, failed: counters.failed },
              windowMs,
            );
            if (delta.state === "no_metrics") noMetrics.push(queue);
            if (delta.windowCoveredMs !== null) {
              coveredMs = coveredMs === null ? delta.windowCoveredMs : Math.max(coveredMs, delta.windowCoveredMs);
            }
            return condition.kind === "failed_above"
              ? { kind: "failed_above", failed: delta.failed, state: delta.state }
              : { kind: "failed_rate_above", failed: delta.failed, completed: delta.completed, state: delta.state };
          }
        }
      });
      const samples = measurements.map(
        (m): Sample =>
          m
            ? measure(condition, m)
            : // connection row vanished mid-tick: unknown, not healthy
              { breached: null, value: null, threshold: thresholdOf(condition), unit: null, state: "warming_up" },
      );
      const worst = pickWorst(condition, targets, samples);
      return { ...worst, measurement: summarise(condition, samples, noMetrics, coveredMs) };
    } catch (err) {
      this.deps.log.warn({ alertId: row.id, err: errorText(err) }, "could not measure alert (redis error); keeping state");
      return null;
    }
  }
}

/**
 * Collapse the per-queue samples into one measurement for the DTO/UI.
 *
 * A folder alert can mix states: some queues measurable, some not. Precedence:
 * if ANY queue produced a usable reading the alert is `ok` (it can still fire on
 * that queue) but the unmeasurable queues are named so the UI can say "3 of 5
 * queues are not covered". Only when NOTHING is measurable does the alert go
 * `no_metrics` / `warming_up` and stop deciding altogether.
 */
export function summarise(
  condition: AlertCondition,
  samples: Sample[],
  queuesWithoutMetrics: string[],
  windowCoveredMs: number | null,
): AlertMeasurement {
  const source: AlertMeasurement["source"] = isErrorAlertKind(condition.kind) ? "metrics" : "counts";
  const base: AlertMeasurement = { source, state: "ok", windowCoveredMs };
  if (queuesWithoutMetrics.length > 0) base.queuesWithoutMetrics = [...queuesWithoutMetrics];
  if (samples.some((s) => s.state === "ok")) return base;
  // nothing measurable: no_metrics wins over warming_up, it is the actionable one
  base.state = samples.some((s) => s.state === "no_metrics") ? "no_metrics" : "warming_up";
  base.windowCoveredMs = null;
  return base;
}

/**
 * A folder alert fires when ANY of its queues breaches. Report the worst one:
 * a breached queue beats a healthy one, then the highest value wins.
 * If no queue has enough data the sample is inconclusive (breached null).
 */
export function pickWorst(condition: AlertCondition, targets: Target[], samples: Sample[]): Omit<Measured, "measurement"> {
  let best: Omit<Measured, "measurement"> | null = null;
  for (let i = 0; i < samples.length; i++) {
    const sample = samples[i] as Sample;
    if (sample.breached === null) continue;
    const target = targets[i] as Target;
    if (!best) {
      best = { sample, target };
      continue;
    }
    const bestBreached = best.sample.breached === true;
    if (sample.breached && !bestBreached) {
      best = { sample, target };
    } else if (sample.breached === bestBreached && (sample.value ?? -1) > (best.sample.value ?? -1)) {
      best = { sample, target };
    }
  }
  if (!best) {
    const state: Sample["state"] = samples.some((x) => x.state === "no_metrics")
      ? "no_metrics"
      : samples.some((x) => x.state === "warming_up")
        ? "warming_up"
        : "ok";
    return { sample: { breached: null, value: null, threshold: thresholdOf(condition), unit: null, state }, target: null };
  }
  return best;
}

export function thresholdOf(condition: AlertCondition): number | null {
  switch (condition.kind) {
    case "waiting_above":
    case "failed_above":
      return condition.threshold;
    case "failed_rate_above":
      return condition.percent;
  }
}

function newCache(): TickCache {
  return { connections: new Map(), stats: new Map(), singleStats: new Map(), counters: new Map() };
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
