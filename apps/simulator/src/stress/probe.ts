/**
 * The "does the dashboard degrade my operation" probe.
 *
 * A producer adds RATE jobs/s to stress.live one by one and measures each
 * `queue.add` round trip; a Worker processes them (WORK_MS each). Once a second
 * it appends a JSONL row with the raw add latencies, add errors, jobs completed
 * and the queue latency (processedOn - timestamp) of the jobs finished in that
 * second. Runs until killed. The report joins these rows with phase windows.
 */
import { mkdirSync } from "node:fs";
import { Queue, Worker } from "bullmq";
import { QUEUES, PREFIX, OUT_DIR, appendJsonl, payload, redisOpts, sleep } from "./common.js";

const RATE = Number(process.env.RATE ?? 200);
const WORK_MS = Number(process.env.WORK_MS ?? 5);
const CONCURRENCY = Number(process.env.CONCURRENCY ?? 16);
const connection = redisOpts();
mkdirSync(OUT_DIR, { recursive: true });
const file = `${OUT_DIR}/probe.jsonl`;

const queue = new Queue(QUEUES.live, { connection, prefix: PREFIX });
let adds: number[] = [], addErrors = 0, completed = 0, qlat: number[] = [], seq = 0;

const worker = new Worker(QUEUES.live, async () => { await sleep(WORK_MS); }, {
  connection, prefix: PREFIX, concurrency: CONCURRENCY,
  removeOnComplete: { count: 5_000 }, removeOnFail: { count: 5_000 },
});
worker.on("completed", (job) => { completed++; if (job.processedOn && job.timestamp) qlat.push(job.processedOn - job.timestamp); });

const everyMs = 1000 / RATE;
setInterval(() => {
  const t = performance.now();
  queue.add("live", payload(1_024, seq++)).then(() => adds.push(performance.now() - t)).catch(() => { addErrors++; });
}, everyMs);

setInterval(() => {
  const a = adds.sort((x, y) => x - y), q = qlat.sort((x, y) => x - y);
  appendJsonl(file, { t: Date.now(), adds: a.length, addErrors, completed, addMs: a.map((v) => Math.round(v * 100) / 100), qlatMs: q });
  process.stdout.write(`\r[probe] adds/s ${a.length} p99 ${(a[Math.floor(a.length * 0.99)] ?? 0).toFixed(1)}ms max ${(a[a.length - 1] ?? 0).toFixed(1)}ms · done/s ${completed} · qlat p99 ${q[Math.floor(q.length * 0.99)] ?? 0}ms   `);
  adds = []; qlat = []; addErrors = 0; completed = 0;
}, 1000);

process.on("SIGINT", async () => { await worker.close(); await queue.close(); process.exit(0); });
