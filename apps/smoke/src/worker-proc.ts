/**
 * A steady BullMQ workload in its own process, so the load generator in the
 * parent never steals its event loop: a producer keeps ~2 000 jobs waiting and
 * workers process them (2 ms of "work" each). Once a second it prints one JSON
 * line: jobs completed in that second and the claim→finish time percentiles.
 *
 *   tsx src/worker-proc.ts <pgUrl> <schema> <queue> <concurrency>
 */
import { setTimeout as sleep } from "node:timers/promises";
import { createPostgresBackend, Queue, Worker } from "bullmq";

const [url, schema, queueName, concurrencyArg] = process.argv.slice(2) as [string, string, string, string];
const connection = { connectionString: url, schema, max: 10 } as never;
const BACKLOG = 2_000;

const queue = new Queue(queueName, { connection }, createPostgresBackend as never);
let added = 0;
let completed = 0;
let window: number[] = [];
let windowCount = 0;

const worker = new Worker(
  queueName,
  async () => {
    await sleep(2);
    return 1;
  },
  { connection, concurrency: Number(concurrencyArg), removeOnComplete: { count: 1000 } },
  createPostgresBackend as never,
);
worker.on("error", () => undefined);
worker.on("completed", (job) => {
  completed += 1;
  windowCount += 1;
  if (job.processedOn && job.finishedOn) window.push(job.finishedOn - job.processedOn);
});

let stopping = false;
async function produce(): Promise<void> {
  while (!stopping) {
    if (added - completed < BACKLOG) {
      const batch = Array.from({ length: 200 }, (_, i) => ({ name: "tick", data: { i: added + i } }));
      await queue.addBulk(batch).catch(() => undefined);
      added += batch.length;
    } else {
      await sleep(20);
    }
  }
}
void produce();

const pct = (xs: number[], p: number) => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.max(0, Math.ceil((p / 100) * s.length) - 1)];
};

const timer = setInterval(() => {
  process.stdout.write(`${JSON.stringify({ t: Date.now(), completed: windowCount, p50: pct(window, 50), p95: pct(window, 95), p99: pct(window, 99) })}\n`);
  window = [];
  windowCount = 0;
}, 1000);

process.on("SIGTERM", async () => {
  stopping = true;
  clearInterval(timer);
  await worker.close(true).catch(() => undefined);
  await queue.close().catch(() => undefined);
  process.exit(0);
});
