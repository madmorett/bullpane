/**
 * Alert evaluation loop. Runs every BMV_ALERTS_INTERVAL seconds while the
 * edition is pro (a license or DEMO_MODE). One ping and one getQueueStats per
 * connection per tick, shared by every alert on that connection.
 */
import type { Alert, AlertCondition, FolderQueueRef } from "@bullmq-visualizer/shared";
import type { Inspector, QueueStats, WindowCounts } from "@bullmq-visualizer/redis-inspector";
import type { Config } from "../config";
import type { AlertRow, ConnectionRow } from "../db/schema";
import type { AlertsService } from "../services/alerts";
import type { ConnectionsService } from "../services/connections";
import type { EditionService } from "../services/edition";
import type { FoldersService } from "../services/folders";
import { mapWithConcurrency } from "../services/flows";
import { alertLink, deliverToAll, type DeliveryResult, type FetchLike } from "./deliver";
import { evaluateAlert, formatMessage, measure, type Measurement, type Sample } from "./evaluate";
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
  windows: Map<string, Promise<WindowCounts>>;
}

/** One queue an alert watches. */
export type Target = FolderQueueRef;

interface Measured {
  sample: Sample;
  /** the queue the reported value belongs to (worst queue for folder alerts); null when inconclusive */
  target: Target | null;
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
    const sample: Sample = { breached: true, value: null, threshold: thresholdOf(row.condition), unit: null };
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

    const measured = await this.measure(row, scope.targets, cache, now);
    if (!measured) return; // Redis unreachable: keep state, try next tick

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

  private windowCounts(inspector: Inspector, queue: string, since: number, cache: TickCache): Promise<WindowCounts> {
    const key = `${inspector.config.id}:${queue}:${since}`;
    let p = cache.windows.get(key);
    if (!p) {
      p = inspector.getWindowCounts(queue, since);
      cache.windows.set(key, p);
    }
    return p;
  }

  /**
   * Measure every target queue (grouped by connection so each connection gets ONE
   * discovery + ONE stats pipeline per tick) and report the worst one.
   */
  private async measure(row: AlertRow, targets: Target[], cache: TickCache, now: number): Promise<Measured | null> {
    const condition = row.condition;
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
            // "waiting" for a human includes paused and prioritized backlog.
            const waiting = counts ? counts.waiting + counts.paused + counts.prioritized : 0;
            return { kind: "waiting_above", waiting };
          }
          case "failed_above": {
            const w = await this.windowCounts(inspector, queue, now - condition.windowMinutes * 60_000, cache);
            return { kind: "failed_above", failed: w.failed };
          }
          case "failed_rate_above": {
            const w = await this.windowCounts(inspector, queue, now - condition.windowMinutes * 60_000, cache);
            return { kind: "failed_rate_above", failed: w.failed, completed: w.completed };
          }
        }
      });
      const samples = measurements.map(
        (m): Sample => (m ? measure(condition, m) : { breached: null, value: null, threshold: thresholdOf(condition), unit: null }),
      );
      return pickWorst(condition, targets, samples);
    } catch (err) {
      this.deps.log.warn({ alertId: row.id, err: errorText(err) }, "could not measure alert (redis error); keeping state");
      return null;
    }
  }
}

/**
 * A folder alert fires when ANY of its queues breaches. Report the worst one:
 * a breached queue beats a healthy one, then the highest value wins.
 * If no queue has enough data the sample is inconclusive (breached null).
 */
export function pickWorst(condition: AlertCondition, targets: Target[], samples: Sample[]): Measured {
  let best: Measured | null = null;
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
    return { sample: { breached: null, value: null, threshold: thresholdOf(condition), unit: null }, target: null };
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
  return { connections: new Map(), stats: new Map(), singleStats: new Map(), windows: new Map() };
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
