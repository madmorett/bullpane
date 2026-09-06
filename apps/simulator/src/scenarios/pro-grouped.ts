import { DelayedError, Queue, Worker, type JobsOptions } from "bullmq";
import type { Redis } from "ioredis";
import type { SimContext } from "../lib/context.js";
import { ProGroupWriter } from "../lib/pro-groups.js";
import * as R from "../lib/random.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const METRICS = { maxDataPoints: 60 * 24 };
const QUEUE = "pro.grouped-tenants";

/**
 * Fakes a BullMQ Pro grouped queue with plain bullmq + hand-written group keys
 * (see lib/pro-groups.ts). Jobs are added through `Queue.add` with
 * `opts.group = { id }` (core keeps unknown opts verbatim) and mirrored into the
 * group lists; a small worker churns them so list sizes move.
 */
export async function startProGrouped(ctx: SimContext, redis: Redis): Promise<void> {
  const { connection, prefix, stats } = ctx;
  const queue = ctx.register(new Queue(QUEUE, { connection, prefix, defaultJobOptions: ctx.defaultJobOptions }));
  const groups = new ProGroupWriter(redis, prefix, QUEUE);

  // Static group state: one paused, one at max concurrency, one rate-limited.
  const PAUSED = "tenant-wonka";
  await groups.setPaused(PAUSED, true);
  await groups.setMaxed("tenant-acme", true);
  await groups.setRateLimited("tenant-hooli", Date.now() + 5 * 60_000);

  // Seed every tenant so the groups view is full from the first refresh.
  for (const gid of R.TENANTS) {
    for (let i = 0; i < R.int(2, 8); i++) await addGrouped(gid);
  }

  async function addGrouped(gid: string): Promise<void> {
    // `group` is a bullmq-pro option; core bullmq stores opts as-is.
    const opts = { group: { id: gid }, attempts: 2, priority: R.chance(0.2) ? R.int(1, 3) : undefined } as JobsOptions;
    const job = await queue.add(
      R.pick(["sync-crm", "rebuild-index", "export-ledger", "recalc-balances"]),
      {
        tenantId: gid,
        requestId: R.id("req"),
        actor: R.email(),
        payload: { records: R.int(10, 5_000), cursor: R.uuid() },
      },
      opts,
    );
    if (job.id) await groups.enqueue(gid, job.id);
    stats.added(QUEUE);
  }

  // Producer: skewed so a couple of tenants are always "noisy".
  ctx.loop("pro.produce", ctx.every(700), async () => {
    const gid = R.chance(0.4) ? R.pick(["tenant-acme", "tenant-globex", PAUSED]) : R.tenant();
    await addGrouped(gid);
  });

  const worker = new Worker(
    QUEUE,
    async (job) => {
      const gid: string = job.data.tenantId;
      // The paused group's jobs stay in their list: a real Pro worker skips them.
      if (gid === PAUSED) {
        await job.moveToDelayed(Date.now() + 10 * 60_000, job.token);
        throw new DelayedError();
      }
      await groups.markActive(gid, job.id!);
      try {
        await job.log(`processing for ${gid}`);
        await sleep(R.int(600, 2_500));
        if (R.chance(0.04)) throw new Error(`tenant ${gid}: upstream CRM returned 503`);
        return { ok: true, records: job.data.payload.records };
      } finally {
        await groups.markDone(gid);
      }
    },
    { connection, prefix, concurrency: 3, metrics: METRICS },
  );
  ctx.register(worker);
  worker.on("completed", () => stats.completed(QUEUE));
  worker.on("failed", () => stats.failed(QUEUE));

  // Keep group lists honest (jobs removed by removeOnComplete etc.).
  ctx.loop("pro.reconcile", 30_000, () => groups.reconcile(R.TENANTS), 0);
}
