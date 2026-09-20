import type { Redis } from "ioredis";

/**
 * Deletes every key under `${prefix}:*` using SCAN + UNLINK in batches.
 * Never KEYS, never FLUSHALL: the demo Redis may be shared with something else
 * during local development, and we want the same discipline the dashboard has.
 */
export async function resetPrefix(redis: Redis, prefix: string, log = console.log): Promise<number> {
  let cursor = "0";
  let removed = 0;
  const pattern = `${prefix}:*`;
  do {
    const [next, keys] = await redis.scan(cursor, "MATCH", pattern, "COUNT", 1000);
    cursor = next;
    if (keys.length > 0) {
      // UNLINK frees memory asynchronously; chunk so one call never gets huge.
      for (let i = 0; i < keys.length; i += 500) {
        removed += await redis.unlink(...keys.slice(i, i + 500));
      }
    }
  } while (cursor !== "0");
  log(`[reset] removed ${removed} keys matching ${pattern}`);
  return removed;
}
