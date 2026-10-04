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
import type { InspectorPool } from "@bullpane/redis-inspector";
import Fastify, { type FastifyInstance, type FastifyServerOptions, LogController } from "fastify";
import { AlertsEngine } from "./ee/alerts/engine";
import { SessionService } from "./auth/sessions";
import { type Config, SERVER_ROOT } from "./config";
import type { AppContext } from "./context";
import type { Db } from "./db";
import { registerErrorHandling } from "./plugins/errors";
import { apiPlugin } from "./routes";
import { AlertsService } from "./ee/services/alerts";
import { AuditService } from "./ee/services/audit";
import { ConnectionsService } from "./services/connections";
import { EditionService } from "./services/edition";
import { HttpLicenseClient } from "./services/license-client";
import { AttentionService } from "./services/attention";
import { DrizzleSettingsStore } from "./services/settings-store";
import { FlowsService } from "./ee/services/flows";
import { FoldersService } from "./ee/services/folders";
import { HealthService } from "./services/health";
import { SsoService } from "./ee/services/sso";
import { McpCallBridge } from "./ee/mcp/internal";
import { mcpRootRoutes } from "./ee/mcp/routes";
import { McpService } from "./ee/mcp/service";
import { DrizzleMcpStore, type McpStore } from "./ee/mcp/store";
import { UsersService } from "./services/users";

export interface BuildAppOptions {
  config: Config;
  db: Db;
  pool: InspectorPool;
  logger?: FastifyServerOptions["logger"];
  /** serve WEB_DIST when it exists (default true) */
  serveWeb?: boolean;
  /** tests pass a MemoryMcpStore; production uses MySQL */
  mcpStore?: McpStore;
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
  const sso = new SsoService(db, config, new DrizzleSettingsStore(db), users);
  const connections = new ConnectionsService(db, pool);
  const folders = new FoldersService(db);
  const health = new HealthService(connections);
  connections.onEvict((id) => health.evict(id));
  const flows = new FlowsService(db, connections);
  const alerts = new AlertsService(db, connections, folders);
  const audit = new AuditService(db, app.log);
  const attention = new AttentionService(new DrizzleSettingsStore(db));
  const mcp = new McpService({ store: opts.mcpStore ?? new DrizzleMcpStore(db), settings: new DrizzleSettingsStore(db), config });
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
    attention,
    sso,
    mcp,
    mcpCalls: new McpCallBridge(),
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
  // MCP + its OAuth server live at the root: clients look for /.well-known/* at
  // the origin and for /mcp where the user pasted it. See ee/mcp/routes.ts.
  await app.register(mcpRootRoutes);

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
      // index.html names the hashed bundles of the running version. Cached for
      // an hour, it survives an upgrade and asks for bundles that are gone: a
      // blank page until the cache expires. Everything else keeps the 1 h.
      setHeaders(reply, filePath) {
        if (path.basename(filePath) === "index.html") reply.header("cache-control", "no-cache");
      },
    });
  }

  // SPA fallback: any non-/api GET that is not a file → index.html.
  app.setNotFoundHandler(async (request, reply) => {
    if (request.url.startsWith("/api")) {
      return reply.status(404).send({ error: "not_found", message: `Route ${request.method} ${request.url} not found` });
    }
    if (serveWeb && (request.method === "GET" || request.method === "HEAD")) {
      // `cacheControl: false`: otherwise the plugin's 1 h max-age replaces this header.
      return reply.header("cache-control", "no-cache").sendFile("index.html", { cacheControl: false });
    }
    return reply.status(404).send({ error: "not_found", message: "Not found" });
  });

  return app;
}
