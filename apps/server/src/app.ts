/**
 * buildApp(): the Fastify instance with every plugin and route registered,
 * plus the service graph on `app.ctx`. Does not touch the database itself
 * (index.ts runs migrations/seeding before listening) so tests can build it
 * against fakes.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import fastifyCookie from "@fastify/cookie";
import fastifyStatic from "@fastify/static";
import type { InspectorPool } from "@bullmq-visualizer/redis-inspector";
import Fastify, { type FastifyInstance, type FastifyServerOptions, LogController } from "fastify";
import { AlertsEngine } from "./alerts/engine";
import { SessionService } from "./auth/sessions";
import { type Config, SERVER_ROOT } from "./config";
import type { AppContext } from "./context";
import type { Db } from "./db";
import { registerErrorHandling } from "./plugins/errors";
import { apiPlugin } from "./routes";
import { AlertsService } from "./services/alerts";
import { AuditService } from "./services/audit";
import { ConnectionsService } from "./services/connections";
import { EditionService } from "./services/edition";
import { HttpLicenseClient } from "./services/license-client";
import { DrizzleSettingsStore } from "./services/settings-store";
import { FlowsService } from "./services/flows";
import { FoldersService } from "./services/folders";
import { HealthService } from "./services/health";
import { UsersService } from "./services/users";

export interface BuildAppOptions {
  config: Config;
  db: Db;
  pool: InspectorPool;
  logger?: FastifyServerOptions["logger"];
  /** serve WEB_DIST when it exists (default true) */
  serveWeb?: boolean;
}

export function readVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(path.join(SERVER_ROOT, "package.json"), "utf8")) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export async function buildApp(opts: BuildAppOptions): Promise<FastifyInstance> {
  const { config, db, pool } = opts;
  const app = Fastify({
    logger: opts.logger ?? { level: config.logLevel },
    trustProxy: true,
    bodyLimit: 2 * 1024 * 1024,
    // The sidebar polls /queues every 5 s; only log mutations per request. Errors are logged by the error handler.
    logController: new LogController({
      disableRequestLogging: (request) => request.method === "GET" || request.method === "HEAD",
    }),
  });

  const version = readVersion();
  const edition = new EditionService({
    config,
    settings: new DrizzleSettingsStore(db),
    log: app.log,
    client: new HttpLicenseClient(config.licenseApiUrl, { userAgent: `bullpane-server/${version}` }),
    version,
  });
  const sessions = new SessionService(db);
  const users = new UsersService(db);
  const connections = new ConnectionsService(db, pool);
  const folders = new FoldersService(db);
  const health = new HealthService(connections);
  connections.onEvict((id) => health.evict(id));
  const flows = new FlowsService(db, connections);
  const alerts = new AlertsService(db, connections, folders);
  const audit = new AuditService(db, app.log);
  const alertsEngine = new AlertsEngine({ config, alerts, connections, folders, edition, log: app.log });

  const ctx: AppContext = {
    config,
    db,
    pool,
    edition,
    sessions,
    users,
    connections,
    folders,
    health,
    flows,
    alerts,
    alertsEngine,
    audit,
    version,
  };
  app.decorate("ctx", ctx);

  await app.register(fastifyCookie, { secret: config.sessionSecret, hook: "onRequest" });
  registerErrorHandling(app);

  // Be lenient with clients that send `content-type: application/json` on
  // body-less requests (curl, some SDKs): treat an empty body as "no body"
  // instead of Fastify's default 400.
  app.removeContentTypeParser("application/json");
  app.addContentTypeParser("application/json", { parseAs: "string" }, (_req, body, done) => {
    const text = typeof body === "string" ? body : body.toString("utf8");
    if (text.trim() === "") return done(null, undefined);
    try {
      done(null, JSON.parse(text));
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      (e as Error & { statusCode?: number }).statusCode = 400;
      done(e, undefined);
    }
  });

  await app.register(apiPlugin, { prefix: "/api" });

  const serveWeb = opts.serveWeb !== false && existsSync(path.join(config.webDist, "index.html"));
  if (serveWeb) {
    await app.register(fastifyStatic, {
      root: config.webDist,
      prefix: "/",
      wildcard: true,
      index: ["index.html"],
      cacheControl: true,
      maxAge: "1h",
      immutable: false,
    });
  }

  // SPA fallback: any non-/api GET that is not a file → index.html.
  app.setNotFoundHandler(async (request, reply) => {
    if (request.url.startsWith("/api")) {
      return reply.status(404).send({ error: "not_found", message: `Route ${request.method} ${request.url} not found` });
    }
    if (serveWeb && (request.method === "GET" || request.method === "HEAD")) {
      return reply.header("cache-control", "no-cache").sendFile("index.html");
    }
    return reply.status(404).send({ error: "not_found", message: "Not found" });
  });

  return app;
}
