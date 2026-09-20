/**
 * DEMO_MODE seeding: admin user, the "Demo Redis" connection, three folders and
 * two alerts so the public playground has content on first boot. Idempotent.
 */
import type { AppContext } from "../context";

export const DEMO_CONNECTION_NAME = "Demo Redis";

/** Queue names produced by apps/simulator. */
export const DEMO_QUEUES = [
  "payments.charge",
  "payments.refund",
  "payments.webhook-dispatch",
  "notifications.email",
  "notifications.sms",
  "notifications.push",
  "pipeline.ingest",
  "pipeline.transform",
  "pipeline.load",
  "reports.daily",
  "media.thumbnails",
  "pro.grouped-tenants",
] as const;

export const DEMO_FOLDERS: Array<{ name: string; color: string; prefix: string }> = [
  { name: "Payments", color: "#f59e0b", prefix: "payments." },
  { name: "Notifications", color: "#3b82f6", prefix: "notifications." },
  { name: "Data pipeline", color: "#10b981", prefix: "pipeline." },
];

const DEMO_WEBHOOK = "https://example.com/webhook";

export interface SeedLogger {
  info(obj: object, msg: string): void;
}

export async function seedDemo(
  ctx: Pick<AppContext, "config" | "users" | "connections" | "folders" | "alerts">,
  log: SeedLogger,
): Promise<void> {
  const { config } = ctx;

  // 1. admin
  const email = config.demoAdminEmail.toLowerCase();
  if (!(await ctx.users.findByEmail(email))) {
    await ctx.users.create({ email, name: "Demo Admin", role: "admin", password: config.demoAdminPassword });
    log.info({ email }, "demo: admin user created");
  }

  // 2. connection
  let connection = await ctx.connections.findByName(DEMO_CONNECTION_NAME);
  if (!connection && (await ctx.connections.count()) === 0) {
    const created = await ctx.connections.create({
      name: DEMO_CONNECTION_NAME,
      url: config.demoRedisUrl,
      prefix: "bull",
      cluster: false,
      queueFilter: null,
    });
    connection = await ctx.connections.getRow(created.id);
    log.info({ id: created.id }, "demo: connection seeded");
  }
  if (!connection) {
    const rows = await ctx.connections.listRows();
    connection = rows[0] ?? null;
  }
  if (!connection) return;
  const connectionId = connection.id;

  // 3. folders
  if ((await ctx.folders.count()) === 0) {
    for (const def of DEMO_FOLDERS) {
      const folder = await ctx.folders.create({ name: def.name, color: def.color, parentId: null });
      const queues = DEMO_QUEUES.filter((q) => q.startsWith(def.prefix)).map((queueName) => ({
        connectionId,
        queueName,
      }));
      await ctx.folders.setQueues(folder.id, queues);
    }
    log.info({ folders: DEMO_FOLDERS.length }, "demo: folders seeded");
  }

  // 4. alerts: one per queue, one per folder
  if ((await ctx.alerts.count()) === 0) {
    await ctx.alerts.create({
      name: "Payments backlog",
      enabled: true,
      scope: { type: "queue", connectionId, queueName: "payments.charge" },
      condition: { kind: "waiting_above", threshold: 500 },
      channels: [{ type: "webhook", url: DEMO_WEBHOOK }],
      cooldownMinutes: 30,
    });
    const paymentsFolder = (await ctx.folders.list()).find((f) => f.name === "Payments");
    if (paymentsFolder) {
      await ctx.alerts.create({
        name: "Payments folder failure rate",
        enabled: true,
        scope: { type: "folder", folderId: paymentsFolder.id },
        condition: { kind: "failed_rate_above", percent: 25, windowMinutes: 5, minSample: 20 },
        channels: [{ type: "webhook", url: DEMO_WEBHOOK }],
        cooldownMinutes: 30,
      });
    }
    log.info({ alerts: paymentsFolder ? 2 : 1 }, "demo: alerts seeded");
  }
}
