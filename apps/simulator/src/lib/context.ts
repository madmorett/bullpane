import type { RedisOptions } from "ioredis";
import type { JobsOptions } from "bullmq";
import { Stats } from "./stats.js";

export interface Closeable {
  close(): Promise<unknown> | unknown;
}

export interface SimConfig {
  redisUrl: string;
  prefix: string;
  /** 0.2 .. 3 — multiplies producer rates. */
  intensity: number;
  reset: boolean;
}

/**
 * Shared state handed to every scenario: connection options, counters, and a
 * registry of things that must be closed on shutdown (workers, queues, timers).
 */
export class SimContext {
  readonly stats = new Stats();
  private readonly closeables: Closeable[] = [];
  private readonly timers = new Set<NodeJS.Timeout>();
  private stopping = false;

  constructor(readonly config: SimConfig) {}

  get prefix(): string {
    return this.config.prefix;
  }

  get stopped(): boolean {
    return this.stopping;
  }

  /**
   * ioredis options derived from REDIS_URL. bullmq wants `maxRetriesPerRequest: null`
   * for blocking worker connections; harmless for queues.
   */
  get connection(): RedisOptions {
    return redisOptionsFromUrl(this.config.redisUrl);
  }

  /** Default job options every producer starts from. Keeps Redis bounded. */
  get defaultJobOptions(): JobsOptions {
    return {
      removeOnComplete: { count: 500 },
      removeOnFail: { count: 1000 },
    };
  }

  /** Scales a base interval (ms) by intensity: higher intensity = shorter interval. */
  every(baseMs: number): number {
    return Math.max(20, Math.round(baseMs / this.config.intensity));
  }

  /** Scales a base count by intensity. */
  scale(n: number): number {
    return Math.max(1, Math.round(n * this.config.intensity));
  }

  register<T extends Closeable>(c: T): T {
    this.closeables.push(c);
    return c;
  }

  /**
   * Runs `fn` repeatedly with `intervalMs` (+ optional jitter) between runs,
   * never overlapping. Errors are logged and do not stop the loop.
   */
  loop(name: string, intervalMs: number | (() => number), fn: () => Promise<void> | void, jitter = 0.2): void {
    const schedule = () => {
      if (this.stopping) return;
      const base = typeof intervalMs === "function" ? intervalMs() : intervalMs;
      const delay = Math.max(10, base * (1 + (Math.random() * 2 - 1) * jitter));
      const t = setTimeout(async () => {
        this.timers.delete(t);
        try {
          await fn();
        } catch (err) {
          if (!this.stopping) console.error(`[${name}]`, (err as Error).message);
        }
        schedule();
      }, delay);
      this.timers.add(t);
    };
    schedule();
  }

  /** One-shot timer that is cancelled on shutdown. */
  after(ms: number, fn: () => Promise<void> | void): void {
    const t = setTimeout(async () => {
      this.timers.delete(t);
      if (this.stopping) return;
      try {
        await fn();
      } catch (err) {
        console.error("[timer]", (err as Error).message);
      }
    }, ms);
    this.timers.add(t);
  }

  async shutdown(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    // Close in reverse registration order: workers first (they were registered
    // after their queues in each scenario), then queues/redis.
    const results = await Promise.allSettled([...this.closeables].reverse().map((c) => c.close()));
    const failed = results.filter((r) => r.status === "rejected").length;
    if (failed) console.warn(`[shutdown] ${failed} resource(s) failed to close cleanly`);
  }
}

export function redisOptionsFromUrl(url: string): RedisOptions {
  const u = new URL(url);
  const opts: RedisOptions = {
    host: u.hostname || "localhost",
    port: u.port ? Number(u.port) : 6379,
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
  };
  if (u.username) opts.username = decodeURIComponent(u.username);
  if (u.password) opts.password = decodeURIComponent(u.password);
  const db = u.pathname.replace(/^\//, "");
  if (db) opts.db = Number(db);
  if (u.protocol === "rediss:") opts.tls = {};
  return opts;
}
