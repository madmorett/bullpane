/**
 * Real BullMQ data in a fresh Postgres schema, produced only through the
 * official bullmq API (Queue, Worker, FlowProducer, job schedulers) with the
 * Postgres backend — so the rows are exactly what a customer has.
 */
import pg from "pg";
import { createPostgresBackend, FlowProducer, Queue, runMigrations, Worker, type Job } from "bullmq";
import { waitFor } from "./harness.js";

export const SEED = {
  ordersWaiting: 62, // 60 orders + needle + big
  ordersDelayed: 3,
  ordersPrioritized: 2,
  emails: 30,
  emailsFailed: 5, // i % 7 === 0 for i in 0..29 → 0,7,14,21,28
  pausedWaiting: 2,
} as const;

export interface Seeded {
  /** the job a worker holds active forever (until the smoke discards it) */
  stuckJobId: string;
  flowRootId: string;
  close: () => Promise<void>;
}

export function pgConnection(url: string, schema: string) {
  return { connectionString: url, schema, max: 4 } as never;
}

export async function resetSchema(url: string, schema: string): Promise<void> {
  const admin = new pg.Client({ connectionString: url });
  await admin.connect();
  try {
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await runMigrations(admin as never, schema);
  } finally {
    await admin.end();
  }
}

export async function dropSchema(url: string, schema: string): Promise<void> {
  const admin = new pg.Client({ connectionString: url });
  await admin.connect();
  await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).finally(() => admin.end());
}

export async function seed(url: string, schema: string): Promise<Seeded> {
  const connection = pgConnection(url, schema);
  const queues: Queue[] = [];
  const workers: Worker[] = [];
  const q = (name: string) => {
    const queue = new Queue(name, { connection }, createPostgresBackend as never);
    queues.push(queue);
    return queue;
  };

  const orders = q("orders");
  for (let i = 0; i < 60; i++) await orders.add("order", { n: i, customer: `c${i}` });
  await orders.add("order", { n: 99, customer: "needle-xyz" });
  await orders.add("big", { blob: "x".repeat(60_000) });
  for (let i = 0; i < SEED.ordersDelayed; i++) await orders.add("later", { i }, { delay: 3_600_000 });
  for (let i = 0; i < SEED.ordersPrioritized; i++) await orders.add("vip", { i }, { priority: 5 });

  const emails = q("emails");
  for (let i = 0; i < SEED.emails; i++) await emails.add("send", { i, fail: i % 7 === 0 }, { attempts: 1 });
  const mailer = new Worker(
    "emails",
    async (job: Job) => {
      await job.log(`sending ${job.id}`);
      await job.updateProgress(50);
      if ((job.data as { fail: boolean }).fail) throw new Error("smtp down");
      return { sent: true };
    },
    { connection, metrics: { maxDataPoints: 60 }, concurrency: 5 },
    createPostgresBackend as never,
  );
  mailer.on("error", () => undefined);
  await waitFor("emails to be processed", async () => {
    const c = await emails.getJobCounts("completed", "failed");
    return c.completed + c.failed === SEED.emails;
  });
  await mailer.close();

  const reports = q("reports");
  await reports.upsertJobScheduler("nightly", { pattern: "0 3 * * *" }, { name: "build", data: { kind: "nightly" } });
  await reports.upsertJobScheduler("hourly", { every: 3_600_000 }, { name: "rollup", data: {} });

  // A FlowProducer writes no meta row: these two queues exist only through their jobs.
  const flow = new FlowProducer({ connection }, createPostgresBackend as never);
  const tree = await flow.add({
    name: "car",
    queueName: "assemble",
    data: {},
    children: [
      { name: "wheel", queueName: "parts", data: { n: 1 } },
      { name: "wheel", queueName: "parts", data: { n: 2 } },
      { name: "engine", queueName: "parts", data: {}, children: [{ name: "piston", queueName: "parts", data: {} }] },
    ],
  });
  await flow.close();

  const frozen = q("frozen");
  await frozen.add("x", {});
  await frozen.add("y", {});
  await frozen.pause();

  // One job held active by a live worker that never finishes it (for discard).
  const stuck = q("stuck");
  const stuckJob = await stuck.add("hang", {}, { attempts: 5 });
  const holder = new Worker("stuck", () => new Promise(() => undefined), { connection, lockDuration: 600_000, name: "holder" }, createPostgresBackend as never);
  holder.on("error", () => undefined);
  workers.push(holder);
  await waitFor("the stuck job to become active", async () => (await stuckJob.getState()) === "active");

  return {
    stuckJobId: String(stuckJob.id),
    flowRootId: String(tree.job.id),
    close: async () => {
      await Promise.allSettled(workers.map((w) => w.close(true)));
      await Promise.allSettled(queues.map((qq) => qq.close()));
    },
  };
}
