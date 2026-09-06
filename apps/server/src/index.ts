/**
 * Process entry point: config → MySQL (wait + migrate) → app → seed (demo) →
 * listen → alerts engine. Graceful shutdown on SIGINT/SIGTERM.
 */
import { createInspectorPool } from "@bullmq-visualizer/redis-inspector";
import { buildApp } from "./app";
import { loadConfig } from "./config";
import { createDatabase, waitForDatabase } from "./db";
import { runMigrations } from "./db/migrate";
import { seedDemo } from "./demo/seed";

async function main(): Promise<void> {
  const config = loadConfig(process.env, { warn: (m) => console.warn(`[config] ${m}`) });
  const database = createDatabase(config.databaseUrl);
  const pool = createInspectorPool({
    discoveryTtlMs: config.queueDiscoveryTtl * 1000,
    previewBytes: config.jobPreviewBytes,
  });

  const app = await buildApp({ config, db: database.db, pool });
  const log = app.log;

  await waitForDatabase(database.pool, log);
  const { applied } = await runMigrations(database.pool, log);
  if (applied.length) log.info({ applied }, "migrations applied");

  const edition = await app.ctx.edition.load();
  if (config.demoMode) await seedDemo(app.ctx, log);
  await app.ctx.sessions.purgeExpired().catch(() => undefined);

  await app.listen({ port: config.port, host: config.host });
  app.ctx.alertsEngine.start();

  const banner = [
    "",
    "  BullMQ Visualizer " + app.ctx.version,
    `  edition : ${edition.tier}${edition.demo ? " (demo)" : ""}${edition.license ? ` — licensed to ${edition.license.licensee}` : ""}`,
    `  url     : ${config.publicUrl}  (listening on ${config.host}:${config.port})`,
    `  web ui  : ${config.webDist}`,
    `  mysql   : ${redactUrl(config.databaseUrl)}`,
    "",
  ].join("\n");
  log.info(banner);

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info({ signal }, "shutting down");
    app.ctx.alertsEngine.stop();
    try {
      await app.close();
      await pool.closeAll();
      await database.close();
      log.info("bye");
      process.exit(0);
    } catch (err) {
      log.error({ err }, "error during shutdown");
      process.exit(1);
    }
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    if (u.password) u.password = "****";
    return u.toString();
  } catch {
    return url;
  }
}

main().catch((err: unknown) => {
  console.error("[fatal]", err instanceof Error ? err.stack ?? err.message : err);
  process.exit(1);
});
