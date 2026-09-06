/**
 * One RedisInspector per connection row, keyed by config.id.
 * If the url / prefix / cluster flag of a known id changes, the old inspector is
 * closed (in the background) and a fresh one takes its place.
 */
import { RedisInspector } from "./inspector.js";
import type { Inspector, InspectorConnectionConfig, InspectorOptions, InspectorPool } from "./types.js";

export class RedisInspectorPool implements InspectorPool {
  private readonly inspectors = new Map<string, RedisInspector>();

  constructor(private readonly options: InspectorOptions = {}) {}

  get(config: InspectorConnectionConfig): Inspector {
    const existing = this.inspectors.get(config.id);
    if (existing && sameTarget(existing.config, config)) return existing;
    if (existing) {
      // connection edited: drop the stale client, never await it on the hot path
      void existing.close().catch(() => undefined);
    }
    const created = new RedisInspector(config, this.options);
    this.inspectors.set(config.id, created);
    return created;
  }

  async evict(id: string): Promise<void> {
    const existing = this.inspectors.get(id);
    if (!existing) return;
    this.inspectors.delete(id);
    await existing.close();
  }

  async closeAll(): Promise<void> {
    const all = [...this.inspectors.values()];
    this.inspectors.clear();
    await Promise.allSettled(all.map((i) => i.close()));
  }

  /** ids currently held (for diagnostics / tests). */
  ids(): string[] {
    return [...this.inspectors.keys()];
  }
}

function sameTarget(a: Inspector["config"], b: InspectorConnectionConfig): boolean {
  return (
    a.url === b.url &&
    a.prefix === (b.prefix ?? "bull") &&
    a.cluster === (b.cluster ?? false) &&
    (a.queueFilter ?? null) === (b.queueFilter ?? null)
  );
}

export function createInspectorPool(options: InspectorOptions = {}): RedisInspectorPool {
  return new RedisInspectorPool(options);
}
