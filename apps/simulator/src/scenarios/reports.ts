import { Queue, Worker } from "bullmq";
import type { SimContext } from "../lib/context.js";
import * as R from "../lib/random.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const METRICS = { maxDataPoints: 60 * 24 };

/**
 * reports.daily: a few long-delayed one-off jobs plus repeatable jobs, so the
 * delayed/repeat machinery (job schedulers, `repeat` opts, delayed zset with
 * far-future scores) is visible.
 */
export async function startReports(ctx: SimContext): Promise<void> {
  const { connection, prefix, stats } = ctx;
  const queue = ctx.register(new Queue("reports.daily", { connection, prefix, defaultJobOptions: ctx.defaultJobOptions }));

  // Job schedulers = the modern repeat API (bullmq >= 5.16). One per tenant-ish.
  await queue.upsertJobScheduler(
    "revenue-summary",
    { every: 60_000 },
    { name: "revenue-summary", data: { report: "revenue-summary", tenantId: "tenant-acme", format: "pdf" } },
  );
  await queue.upsertJobScheduler(
    "churn-cohorts",
    { every: 5 * 60_000 },
    { name: "churn-cohorts", data: { report: "churn-cohorts", tenantId: "tenant-globex", format: "csv" } },
  );
  // Legacy-style `repeat` option, still accepted by bullmq 5.x. Kept so both
  // shapes exist in Redis (the dashboard should render either).
  await queue.add(
    "reconciliation",
    { report: "reconciliation", tenantId: "tenant-initech", format: "xlsx" },
    { repeat: { every: 60_000 }, jobId: "reconciliation" },
  );
  stats.added("reports.daily", 3);

  // Long-delayed one-offs: "generate at 06:00", up to 10 minutes out in demo time.
  ctx.loop("reports.produce", ctx.every(45_000), async () => {
    await queue.add(
      "custom-export",
      {
        report: "custom-export",
        tenantId: R.tenant(),
        requestedBy: R.email(),
        filters: { from: "2026-01-01", to: "2026-01-31", status: R.pick(["paid", "refunded", "all"]) },
        format: R.pick(["csv", "xlsx", "pdf"]),
      },
      { delay: R.int(2 * 60_000, 10 * 60_000), attempts: 2 },
    );
    stats.added("reports.daily");
  });

  const worker = new Worker(
    "reports.daily",
    async (job) => {
      await job.log(`building ${job.data.report} for ${job.data.tenantId} as ${job.data.format}`);
      for (let p = 0; p <= 100; p += 20) {
        await sleep(R.int(150, 500));
        await job.updateProgress({ percent: p, stage: p < 50 ? "query" : p < 90 ? "render" : "upload" });
      }
      if (R.chance(0.05)) throw new Error("warehouse query timed out after 30000ms");
      return { url: `https://files.example.com/reports/${R.uuid()}.${job.data.format}`, rows: R.int(100, 50_000) };
    },
    { connection, prefix, concurrency: 1, metrics: METRICS },
  );
  ctx.register(worker);
  worker.on("completed", () => stats.completed("reports.daily"));
  worker.on("failed", () => stats.failed("reports.daily"));
}
