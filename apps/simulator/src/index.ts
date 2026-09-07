/**
 * Bullpane demo simulator.
 *
 * Keeps a Redis looking like a busy mid-sized company so the dashboard has
 * something to show: payments, notifications, an ETL flow, reports, media,
 * a fake BullMQ Pro grouped queue and a paused legacy queue.
 *
 * Env:
 *   REDIS_URL       redis://localhost:6379
 *   BULL_PREFIX     bull
 *   SIM_INTENSITY   0.2 .. 3 (default 1) — scales producer rates
 *   SIM_RESET=true  SCAN+UNLINK everything under the prefix before starting
 */
import IORedis from "ioredis";
import { SimContext, redisOptionsFromUrl, type SimConfig } from "./lib/context.js";
import { resetPrefix } from "./lib/reset.js";
import { startPayments } from "./scenarios/payments.js";
import { startNotifications } from "./scenarios/notifications.js";
import { startPipeline } from "./scenarios/pipeline.js";
import { startReports } from "./scenarios/reports.js";
import { startMedia } from "./scenarios/media.js";
import { startProGrouped } from "./scenarios/pro-grouped.js";
import { startLegacy } from "./scenarios/legacy.js";

function readConfig(): SimConfig {
  const intensityRaw = Number(process.env.SIM_INTENSITY ?? "1");
  const intensity = Number.isFinite(intensityRaw) ? Math.min(3, Math.max(0.2, intensityRaw)) : 1;
  return {
    redisUrl: process.env.REDIS_URL ?? "redis://localhost:6379",
    prefix: process.env.BULL_PREFIX ?? "bull",
    intensity,
    reset: (process.env.SIM_RESET ?? "false").toLowerCase() === "true",
  };
}

async function main(): Promise<void> {
  const config = readConfig();
  const ctx = new SimContext(config);
  const redis = new IORedis(redisOptionsFromUrl(config.redisUrl));
  ctx.register({ close: () => redis.quit() });

  console.log(
    `[sim] redis=${config.redisUrl.replace(/\/\/.*@/, "//***@")} prefix=${config.prefix} intensity=${config.intensity} reset=${config.reset}`,
  );
  await redis.ping();
  if (config.reset) await resetPrefix(redis, config.prefix);

  await Promise.all([
    startPayments(ctx),
    startNotifications(ctx),
    startPipeline(ctx),
    startReports(ctx),
    startMedia(ctx),
    startProGrouped(ctx, redis),
    startLegacy(ctx),
  ]);
  console.log("[sim] all scenarios running. Ctrl+C to stop.");

  ctx.loop("status", 10_000, () => console.log(`[sim ${new Date().toISOString().slice(11, 19)}] ${ctx.stats.flush()}`), 0);

  let shuttingDown = false;
  const stop = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n[sim] ${signal} received, closing workers and queues...`);
    const killer = setTimeout(() => {
      console.error("[sim] shutdown timed out, exiting hard");
      process.exit(1);
    }, 15_000);
    await ctx.shutdown();
    clearTimeout(killer);
    console.log("[sim] bye");
    process.exit(0);
  };
  process.on("SIGINT", () => void stop("SIGINT"));
  process.on("SIGTERM", () => void stop("SIGTERM"));
}

main().catch((err) => {
  console.error("[sim] fatal:", err);
  process.exit(1);
});
