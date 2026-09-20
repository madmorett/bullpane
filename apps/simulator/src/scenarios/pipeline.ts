import { FlowProducer, Queue, QueueEvents, Worker } from "bullmq";
import type { SimContext } from "../lib/context.js";
import * as R from "../lib/random.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const METRICS = { maxDataPoints: 60 * 24 };

const SOURCES = ["salesforce", "stripe", "postgres.orders", "s3://raw-events", "hubspot", "zendesk"];

/**
 * Real BullMQ flows:
 *
 *   pipeline.load (parent)
 *     └── pipeline.transform (x2-4)
 *           └── pipeline.ingest (x1-3 each)
 *
 * Parents sit in `waiting-children` until their children finish, and every
 * child hash carries `parent: { id, queueKey }` — that is what the dashboard's
 * flow detection samples.
 */
export async function startPipeline(ctx: SimContext): Promise<void> {
  const { connection, prefix, stats } = ctx;
  const jobOpts = ctx.defaultJobOptions;

  // Queues exist mainly so `meta` is created up-front and so pause/clean work
  // from the dashboard; the FlowProducer writes the jobs.
  for (const name of ["pipeline.ingest", "pipeline.transform", "pipeline.load"]) {
    ctx.register(new Queue(name, { connection, prefix, defaultJobOptions: jobOpts }));
  }
  const flow = ctx.register(new FlowProducer({ connection, prefix }));

  ctx.loop("pipeline.produce", ctx.every(4_000), async () => {
    const runId = R.id("run");
    const tenantId = R.tenant();
    const transforms = R.int(2, 4);
    await flow.add({
      name: "load",
      queueName: "pipeline.load",
      data: { runId, tenantId, target: "warehouse.analytics", table: R.pick(["fct_orders", "dim_customers", "fct_payments"]) },
      opts: { ...jobOpts, attempts: 2 },
      children: Array.from({ length: transforms }, (_, t) => ({
        name: "transform",
        queueName: "pipeline.transform",
        data: { runId, tenantId, step: t, rules: R.pick(["dedupe", "normalize-currency", "enrich-geo", "pii-mask"]) },
        opts: { ...jobOpts, attempts: 3, backoff: { type: "exponential", delay: 2_000 } },
        children: Array.from({ length: R.int(1, 3) }, () => ({
          name: "ingest",
          queueName: "pipeline.ingest",
          data: { runId, tenantId, source: R.pick(SOURCES), since: new Date(Date.now() - R.int(1, 48) * 3_600_000).toISOString() },
          opts: { ...jobOpts, attempts: 3, backoff: { type: "exponential", delay: 1_500 } },
        })),
      })),
    });
    stats.added("pipeline.load");
    stats.added("pipeline.transform", transforms);
  });

  const ingest = new Worker(
    "pipeline.ingest",
    async (job) => {
      const rows = R.int(500, 20_000);
      await job.log(`pulling from ${job.data.source} since ${job.data.since}`);
      for (let p = 0; p <= 100; p += 25) {
        await sleep(R.int(100, 400));
        await job.updateProgress(p);
      }
      if (R.chance(0.03)) throw new Error(`source ${job.data.source}: rate limited (429), retry later`);
      return { rows, bytes: rows * R.int(200, 900) };
    },
    { connection, prefix, concurrency: 4, metrics: METRICS },
  );
  const transform = new Worker(
    "pipeline.transform",
    async (job) => {
      const children = await job.getChildrenValues<{ rows: number }>();
      const rows = Object.values(children).reduce((a, c) => a + c.rows, 0);
      await job.log(`applying ${job.data.rules} to ${rows} rows from ${Object.keys(children).length} ingest(s)`);
      await sleep(R.int(300, 1_200));
      if (R.chance(0.02)) throw new Error(`rule ${job.data.rules}: schema drift, column "amount_cents" missing`);
      return { rows, dropped: R.int(0, Math.floor(rows * 0.02)) };
    },
    { connection, prefix, concurrency: 3, metrics: METRICS },
  );
  const load = new Worker(
    "pipeline.load",
    async (job) => {
      const children = await job.getChildrenValues<{ rows: number }>();
      const rows = Object.values(children).reduce((a, c) => a + c.rows, 0);
      await job.log(`COPY ${rows} rows INTO ${job.data.target}.${job.data.table}`);
      await sleep(R.int(500, 2_000));
      return { rows, table: job.data.table, durationMs: R.int(500, 2_000) };
    },
    { connection, prefix, concurrency: 2, metrics: METRICS },
  );
  for (const [name, w] of [
    ["pipeline.ingest", ingest],
    ["pipeline.transform", transform],
    ["pipeline.load", load],
  ] as const) {
    ctx.register(w);
    w.on("completed", () => stats.completed(name));
    w.on("failed", () => stats.failed(name));
  }
  // ingest jobs are created by the flow, count them as they enter `waiting`
  const ingestEvents = ctx.register(new QueueEvents("pipeline.ingest", { connection, prefix }));
  ingestEvents.on("waiting", () => stats.added("pipeline.ingest"));
}
