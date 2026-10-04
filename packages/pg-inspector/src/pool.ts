/**
 * One PgInspector per connection row, keyed by config.id. Editing the url,
 * schema or filter of a known id closes the old inspector (in the background)
 * and opens a fresh one, like RedisInspectorPool.
 */
import type { Inspector, InspectorConnectionConfig, InspectorOptions, InspectorPool } from "@bullpane/inspector";
import { PgInspector } from "./inspector.js";

export class PgInspectorPool implements InspectorPool {
  private readonly inspectors = new Map<string, PgInspector>();

  constructor(private readonly options: InspectorOptions = {}) {}

  get(config: InspectorConnectionConfig): Inspector {
    const existing = this.inspectors.get(config.id);
    if (existing && sameTarget(existing.config, config)) return existing;
    if (existing) void existing.close().catch(() => undefined);
    const created = new PgInspector(config, this.options);
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
}

function sameTarget(a: Inspector["config"], b: InspectorConnectionConfig): boolean {
  return a.url === b.url && a.prefix === (b.prefix ?? "bullmq") && (a.queueFilter ?? null) === (b.queueFilter ?? null);
}
