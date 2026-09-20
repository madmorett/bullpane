import type { Redis } from "ioredis";

/**
 * Writes the BullMQ Pro group key layout by hand so the public demo shows the
 * groups view without a @taskforcesh/bullmq-pro token.
 *
 * Layout verified against @taskforcesh/bullmq-pro 7.48.0. It MUST match
 * `GROUP_KEY` in packages/redis-inspector/src/keys.ts (the reader); adjust both
 * together. A group sits in exactly ONE status zset:
 *
 *   ${base}:groups                zset  waiting groups (round-robin score)
 *   ${base}:groups:limit          zset  rate-limited groups -> ms the limit lifts
 *   ${base}:groups:max            zset  groups at their concurrency cap -> ms they got there
 *   ${base}:groups:paused         zset  paused groups -> ms paused
 *   ${base}:groups:${gid}         list  waiting job ids (LPUSH; Pro RPOPLPUSHes the tail)
 *   ${base}:groups:${gid}:p       zset  prioritized waiting jobs
 *   ${base}:groups:${gid}:meta    hash  conc / lm / ld = per-group concurrency / rate limit
 *   ${base}:groups:${gid}:limit   string rate-limit counter, PEXPIRE = duration, >= 999999 = limited
 *   ${base}:groups:active:count   hash  gid -> jobs active now
 *   ${base}:groups:metas          zset  gids with a meta hash
 *   ${base}:groups-lid            string last group served
 *
 * The job hash carries `gid`. Plain bullmq enforces none of this; this class only
 * mirrors what a Pro worker would have written so the dashboard reads honest keys.
 */
export const PRO_GROUP_KEYS = {
  groups: (base: string) => `${base}:groups`,
  limit: (base: string) => `${base}:groups:limit`,
  max: (base: string) => `${base}:groups:max`,
  paused: (base: string) => `${base}:groups:paused`,
  group: (base: string, gid: string) => `${base}:groups:${gid}`,
  groupPrioritized: (base: string, gid: string) => `${base}:groups:${gid}:p`,
  groupMeta: (base: string, gid: string) => `${base}:groups:${gid}:meta`,
  groupLimit: (base: string, gid: string) => `${base}:groups:${gid}:limit`,
  activeCount: (base: string) => `${base}:groups:active:count`,
  metas: (base: string) => `${base}:groups:metas`,
  lastId: (base: string) => `${base}:groups-lid`,
  /** job hash field holding the group id */
  jobField: "gid",
} as const;

/** What queue.setGroupConcurrency / setGroupRateLimit would store for one group. */
export interface GroupMeta {
  concurrency?: number;
  limit?: { max: number; duration: number };
}

export class ProGroupWriter {
  private readonly base: string;
  /** per-group overrides we wrote, so markActive knows each group's cap */
  private readonly metas = new Map<string, GroupMeta>();

  constructor(
    private readonly redis: Redis,
    prefix: string,
    queue: string,
  ) {
    this.base = `${prefix}:${queue}`;
  }

  /** Per-group override: the `groups:${gid}:meta` hash plus membership in `groups:metas`. */
  async setMeta(gid: string, meta: GroupMeta): Promise<void> {
    this.metas.set(gid, meta);
    const fields: Record<string, string> = {};
    if (meta.concurrency) fields.conc = String(meta.concurrency);
    if (meta.limit) {
      fields.lm = String(meta.limit.max);
      fields.ld = String(meta.limit.duration);
    }
    await this.redis.multi().hset(PRO_GROUP_KEYS.groupMeta(this.base, gid), fields).zadd(PRO_GROUP_KEYS.metas(this.base), Date.now(), gid).exec();
  }

  /** Registers a job in its group: HSET gid, LPUSH into the group list, put the group in rotation. */
  async enqueue(gid: string, jobId: string): Promise<void> {
    await this.redis.multi().hset(`${this.base}:${jobId}`, PRO_GROUP_KEYS.jobField, gid).lpush(PRO_GROUP_KEYS.group(this.base, gid), jobId).exec();
    await this.reinsertIfNeeded(gid);
  }

  /** A worker took a job of `gid`: leave the list, count it active, cap the group when it hits its concurrency. */
  async markActive(gid: string, jobId: string): Promise<void> {
    const res = await this.redis
      .multi()
      .lrem(PRO_GROUP_KEYS.group(this.base, gid), 1, jobId)
      .set(PRO_GROUP_KEYS.lastId(this.base), gid)
      .hincrby(PRO_GROUP_KEYS.activeCount(this.base), gid, 1)
      .exec();
    const count = Number(res?.[2]?.[1] ?? 0);
    const cap = this.metas.get(gid)?.concurrency;
    if (cap && count >= cap) {
      await this.redis.multi().zrem(PRO_GROUP_KEYS.groups(this.base), gid).zadd(PRO_GROUP_KEYS.max(this.base), Date.now(), gid).exec();
    }
  }

  /** The job finished: release the slot; un-max the group if that frees it, drop it from rotation if it is empty. */
  async markDone(gid: string): Promise<void> {
    const count = await this.redis.hincrby(PRO_GROUP_KEYS.activeCount(this.base), gid, -1);
    if (count <= 0) await this.redis.hdel(PRO_GROUP_KEYS.activeCount(this.base), gid);
    const cap = this.metas.get(gid)?.concurrency;
    if (cap && count < cap) await this.redis.zrem(PRO_GROUP_KEYS.max(this.base), gid);
    await this.reinsertIfNeeded(gid);
  }

  /** queue.pauseGroup / resumeGroup. */
  async setPaused(gid: string, paused: boolean): Promise<void> {
    if (paused) {
      await this.redis.multi().zrem(PRO_GROUP_KEYS.groups(this.base), gid).zadd(PRO_GROUP_KEYS.paused(this.base), Date.now(), gid).exec();
    } else {
      await this.redis.zrem(PRO_GROUP_KEYS.paused(this.base), gid);
      await this.reinsertIfNeeded(gid);
    }
  }

  /** rateLimitGroup.lua: counter pinned above 999999 with PEXPIRE, group parked in groups:limit until `untilMs`. */
  async setRateLimited(gid: string, untilMs: number | null): Promise<void> {
    if (untilMs) {
      await this.redis
        .multi()
        .set(PRO_GROUP_KEYS.groupLimit(this.base, gid), "1000000", "PX", Math.max(1, untilMs - Date.now()))
        .zrem(PRO_GROUP_KEYS.groups(this.base), gid)
        .zadd(PRO_GROUP_KEYS.limit(this.base), untilMs, gid)
        .exec();
    } else {
      await this.redis.multi().del(PRO_GROUP_KEYS.groupLimit(this.base, gid)).zrem(PRO_GROUP_KEYS.limit(this.base), gid).exec();
      await this.reinsertIfNeeded(gid);
    }
  }

  /** true when a Pro worker would skip this group right now (paused, at its cap, or rate limited). */
  async isBlocked(gid: string): Promise<boolean> {
    const res = await this.redis
      .pipeline()
      .zscore(PRO_GROUP_KEYS.paused(this.base), gid)
      .zscore(PRO_GROUP_KEYS.max(this.base), gid)
      .zscore(PRO_GROUP_KEYS.limit(this.base), gid)
      .exec();
    return (res ?? []).some(([, v]) => v !== null);
  }

  /** In rotation (`groups`) iff it has waiting jobs and is not paused / maxed / limited; out otherwise. */
  private async reinsertIfNeeded(gid: string): Promise<void> {
    const len = await this.redis.llen(PRO_GROUP_KEYS.group(this.base, gid));
    if (len > 0 && !(await this.isBlocked(gid))) {
      await this.redis.zadd(PRO_GROUP_KEYS.groups(this.base), "NX", Date.now(), gid);
    } else {
      await this.redis.zrem(PRO_GROUP_KEYS.groups(this.base), gid);
    }
  }

  /** Drops ids from group lists whose job hash no longer exists; caps list length. */
  async reconcile(gids: readonly string[], maxLen = 200): Promise<void> {
    for (const gid of gids) {
      const key = PRO_GROUP_KEYS.group(this.base, gid);
      const ids = await this.redis.lrange(key, 0, -1);
      if (ids.length === 0) {
        await this.reinsertIfNeeded(gid);
        continue;
      }
      const pipe = this.redis.pipeline();
      for (const jid of ids) pipe.exists(`${this.base}:${jid}`);
      const res = (await pipe.exec()) ?? [];
      const stale = ids.filter((_, i) => res[i]?.[1] === 0);
      if (stale.length) {
        const rm = this.redis.multi();
        for (const jid of stale) rm.lrem(key, 0, jid);
        await rm.exec();
      }
      await this.redis.ltrim(key, 0, maxLen - 1);
      await this.reinsertIfNeeded(gid);
    }
  }
}
