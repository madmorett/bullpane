import type { Redis } from "ioredis";

/**
 * BullMQ Pro group key layout, hand-written so the demo shows the Pro groups
 * view without a @taskforcesh/bullmq-pro token.
 *
 * These names mirror @taskforcesh/bullmq-pro's layout as best understood from
 * observing a Pro queue (it is not officially documented). They MUST match
 * `GROUP_KEY` in packages/redis-inspector/src/keys.ts — that is the reader —
 * and must be adjusted together if Pro changes its layout.
 *
 *   ${prefix}:${queue}:groups            zset  gid -> score (round-robin ordering)
 *   ${prefix}:${queue}:groups:${gid}     list  waiting job ids of the group
 *   ${prefix}:${queue}:groups:active     zset  gids currently being processed
 *   ${prefix}:${queue}:groups:paused     zset  paused gids
 *   ${prefix}:${queue}:groups:max        zset  gids that hit their max concurrency
 *   ${prefix}:${queue}:groups:limit      zset  rate-limited gids -> ms when the limit lifts
 *   ${prefix}:${queue}:groups-lid        string last group id served
 *
 * The job hash additionally carries a `gid` field (the inspector accepts `gid`
 * or `groupId`).
 */
export const PRO_GROUP_KEYS = {
  groups: (base: string) => `${base}:groups`,
  group: (base: string, gid: string) => `${base}:groups:${gid}`,
  active: (base: string) => `${base}:groups:active`,
  paused: (base: string) => `${base}:groups:paused`,
  max: (base: string) => `${base}:groups:max`,
  limit: (base: string) => `${base}:groups:limit`,
  lastId: (base: string) => `${base}:groups-lid`,
  /** job hash field holding the group id */
  jobField: "gid",
} as const;

export class ProGroupWriter {
  private readonly base: string;

  constructor(
    private readonly redis: Redis,
    prefix: string,
    queue: string,
  ) {
    this.base = `${prefix}:${queue}`;
  }

  /** Registers a job in its group: HSET gid, RPUSH into the group list, ZADD the group. */
  async enqueue(gid: string, jobId: string): Promise<void> {
    await this.redis
      .multi()
      .hset(`${this.base}:${jobId}`, PRO_GROUP_KEYS.jobField, gid)
      .rpush(PRO_GROUP_KEYS.group(this.base, gid), jobId)
      .zadd(PRO_GROUP_KEYS.groups(this.base), "NX", Date.now(), gid)
      .exec();
  }

  /** Called when a worker starts processing a job of `gid`. */
  async markActive(gid: string, jobId: string): Promise<void> {
    await this.redis
      .multi()
      .lrem(PRO_GROUP_KEYS.group(this.base, gid), 1, jobId)
      .zadd(PRO_GROUP_KEYS.active(this.base), Date.now(), gid)
      .set(PRO_GROUP_KEYS.lastId(this.base), gid)
      .exec();
  }

  /** Called when the job finishes (ok or failed). Bumps the group score for round robin. */
  async markDone(gid: string): Promise<void> {
    await this.redis
      .multi()
      .zrem(PRO_GROUP_KEYS.active(this.base), gid)
      .zadd(PRO_GROUP_KEYS.groups(this.base), "XX", Date.now(), gid)
      .exec();
  }

  async setPaused(gid: string, paused: boolean): Promise<void> {
    if (paused) await this.redis.zadd(PRO_GROUP_KEYS.paused(this.base), Date.now(), gid);
    else await this.redis.zrem(PRO_GROUP_KEYS.paused(this.base), gid);
  }

  async setMaxed(gid: string, maxed: boolean): Promise<void> {
    if (maxed) await this.redis.zadd(PRO_GROUP_KEYS.max(this.base), Date.now(), gid);
    else await this.redis.zrem(PRO_GROUP_KEYS.max(this.base), gid);
  }

  async setRateLimited(gid: string, untilMs: number | null): Promise<void> {
    if (untilMs) await this.redis.zadd(PRO_GROUP_KEYS.limit(this.base), untilMs, gid);
    else await this.redis.zrem(PRO_GROUP_KEYS.limit(this.base), gid);
  }

  /** Drops ids from group lists whose job hash no longer exists; caps list length. */
  async reconcile(gids: readonly string[], maxLen = 200): Promise<void> {
    for (const gid of gids) {
      const key = PRO_GROUP_KEYS.group(this.base, gid);
      const ids = await this.redis.lrange(key, 0, -1);
      if (ids.length === 0) continue;
      const pipe = this.redis.pipeline();
      for (const jid of ids) pipe.exists(`${this.base}:${jid}`);
      const res = (await pipe.exec()) ?? [];
      const stale = ids.filter((_, i) => res[i]?.[1] === 0);
      if (stale.length) {
        const rm = this.redis.multi();
        for (const jid of stale) rm.lrem(key, 0, jid);
        await rm.exec();
      }
      await this.redis.ltrim(key, -maxLen, -1);
    }
  }
}
