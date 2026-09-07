/**
 * Everything a route handler can reach through `request.server.ctx`.
 * Built by buildApp() in app.ts.
 */
import type { User } from "@bullpane/shared";
import type { InspectorPool } from "@bullpane/redis-inspector";
import type { AlertsEngine } from "./alerts/engine";
import type { SessionService } from "./auth/sessions";
import type { Config } from "./config";
import type { Db } from "./db";
import type { AlertsService } from "./services/alerts";
import type { AuditService } from "./services/audit";
import type { ConnectionsService } from "./services/connections";
import type { EditionService } from "./services/edition";
import type { FlowsService } from "./services/flows";
import type { FoldersService } from "./services/folders";
import type { HealthService } from "./services/health";
import type { UsersService } from "./services/users";

export interface AppContext {
  config: Config;
  db: Db;
  pool: InspectorPool;
  edition: EditionService;
  sessions: SessionService;
  users: UsersService;
  connections: ConnectionsService;
  folders: FoldersService;
  health: HealthService;
  flows: FlowsService;
  alerts: AlertsService;
  alertsEngine: AlertsEngine;
  audit: AuditService;
  /** package.json version */
  version: string;
}

declare module "fastify" {
  interface FastifyInstance {
    ctx: AppContext;
  }
  interface FastifyRequest {
    user: User | null;
    sessionId: string | null;
  }
}
