/**
 * The pool the server holds: one inspector per connection id, built by the
 * backend the connection points at. Redis connections get a RedisInspector,
 * BullMQ 6 Postgres connections a PgInspector; nothing above this file knows
 * which one it is talking to.
 */
import type { InspectorConnectionConfig, InspectorOptions, InspectorPool } from "@bullpane/inspector";
import { PgInspectorPool } from "@bullpane/pg-inspector";
import { RedisInspectorPool } from "@bullpane/redis-inspector";

export function createInspectorPool(options: InspectorOptions = {}): InspectorPool {
  const redis = new RedisInspectorPool(options);
  const postgres = new PgInspectorPool(options);
  const pick = (config: InspectorConnectionConfig) => (config.kind === "postgres" ? postgres : redis);
  return {
    get: (config) => pick(config).get(config),
    // A connection's kind never changes (updateConnectionSchema omits it), but
    // evicting from both costs nothing and cannot leave a stale inspector behind.
    evict: async (id) => {
      await Promise.all([redis.evict(id), postgres.evict(id)]);
    },
    closeAll: async () => {
      await Promise.all([redis.closeAll(), postgres.closeAll()]);
    },
  };
}
