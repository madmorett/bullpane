/**
 * Builds the stress fixture on the dedicated Redis:
 *   stress.backlog  BACKLOG_JOBS waiting jobs, ~BACKLOG_BYTES each (default 2,000,000 × 2 KB)
 *   stress.fat      FAT_JOBS waiting jobs, ~FAT_BYTES each         (default 3,000 × 1 MB)
 *   stress.archive  ARCHIVE_JOBS processed by a real Worker; ~13% fail (default 1,150,000 × 1 KB)
 * Everything goes through the official bullmq API (addBulk + Worker) so the key
 * layout is exactly what customers have. FLUSHALL on the target first (dedicated Redis).
 */
import IORedis from "ioredis";
import { Queue, Worker } from "bullmq";
import { QUEUES, PREFIX, payload, redisOpts, sleep } from "./common.js";

const n = (k: string, d: number) => Number(process.env[k] ?? d);
const BACKLOG_JOBS = n("BACKLOG_JOBS", 2_000_000), BACKLOG_BYTES = n("BACKLOG_BYTES", 2_048);
const FAT_JOBS = n("FAT_JOBS", 3_000), FAT_BYTES = n("FAT_BYTES", 1_048_576);
const ARCHIVE_JOBS = n("ARCHIVE_JOBS", 1_150_000), ARCHIVE_BYTES = n("ARCHIVE_BYTES", 1_024);
const ONLY = process.env.ONLY; // backlog | fat | archive

const connection = redisOpts();
const raw = new IORedis(connection);

async function fill(name: string, count: number, bytes: number, batch: number): Promise<void> {
  const q = new Queue(name, { connection, prefix: PREFIX });
  const t0 = Date.now();
  for (let i = 0; i < count; i += batch) {
    const size = Math.min(batch, count - i);
    const jobs = Array.from({ length: size }, (_, k) => ({ name: "work", data: payload(bytes, i + k) }));
    await q.addBulk(jobs);
    if ((i / batch) % Math.max(1, Math.floor(200_000 / batch)) === 0) {
      const mem = (await raw.info("memory")).match(/used_memory_human:(\S+)/)?.[1];
      console.log(`[load] ${name} ${i + size}/${count} · ${Math.round((i + size) / ((Date.now() - t0) / 1000))} jobs/s · redis ${mem}`);
    }
  }
  await q.close();
  console.log(`[load] ${name} done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

async function archive(): Promise<void> {
  await fill(QUEUES.archive, ARCHIVE_JOBS, ARCHIVE_BYTES, 2_000);
  const t0 = Date.now();
  let done = 0, failed = 0;
  const worker = new Worker(
    QUEUES.archive,
    async (job) => {
      if (Number(job.id) % 8 === 0) throw new Error(`upstream 503 for ${job.data.orderId}`);
      return { ok: true };
    },
    { connection, prefix: PREFIX, concurrency: 200, removeOnComplete: { count: 10_000_000 }, removeOnFail: { count: 10_000_000 } },
  );
  worker.on("completed", () => { done++; });
  worker.on("failed", () => { failed++; });
  const q = new Queue(QUEUES.archive, { connection, prefix: PREFIX });
  while (true) {
    const c = await q.getJobCounts("waiting", "active", "prioritized", "delayed");
    const left = c.waiting + c.active + c.prioritized + c.delayed;
    console.log(`[load] archive processing · left ${left} · completed ${done} · failed ${failed} · ${Math.round((done + failed) / ((Date.now() - t0) / 1000))} jobs/s`);
    if (left === 0) break;
    await sleep(5_000);
  }
  await worker.close();
  await q.close();
}

async function main(): Promise<void> {
  console.log(`[load] target ${connection.host}:${connection.port} prefix=${PREFIX}`);
  if (!ONLY) { await raw.flushall(); console.log("[load] FLUSHALL"); }
  if (!ONLY || ONLY === "backlog") await fill(QUEUES.backlog, BACKLOG_JOBS, BACKLOG_BYTES, 2_000);
  if (!ONLY || ONLY === "fat") await fill(QUEUES.fat, FAT_JOBS, FAT_BYTES, 10);
  if (!ONLY || ONLY === "archive") await archive();
  console.log("[load] keys:", await raw.dbsize(), "memory:", (await raw.info("memory")).match(/used_memory_human:(\S+)/)?.[1]);
  await raw.quit();
}
void main();
