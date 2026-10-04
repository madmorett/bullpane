/**
 * Everything a route handler can reach through `request.server.ctx`.
 * Built by buildApp() in app.ts.
 */
import type { User } from "@bullpane/shared";
import type { InspectorPool } from "@bullpane/redis-inspector";
import type { AlertsEngine } from "./ee/alerts/engine";
import type { SessionService } from "./auth/sessions";
import type { Config } from "./config";
import type { Db } from "./db";
import type { AlertsService } from "./ee/services/alerts";
import type { AttentionService } from "./services/attention";
import type { AuditService } from "./ee/services/audit";
import type { ConnectionsService } from "./services/connections";
import type { EditionService } from "./services/edition";
import type { FlowsService } from "./ee/services/flows";
import type { FoldersService } from "./ee/services/folders";
import type { HealthService } from "./services/health";
import type { SsoService } from "./ee/services/sso";
import type { McpCallBridge, McpCallIdentity } from "./ee/mcp/internal";
import type { McpService } from "./ee/mcp/service";
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
  attention: AttentionService;
  sso: SsoService;
  mcp: McpService;
  /** hands an MCP caller's identity to the /api request a tool makes (ee/mcp/internal.ts) */
  mcpCalls: McpCallBridge;
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
    /** set when this /api request is an MCP tool call; the audit row says `via: mcp` */
    mcpCall: McpCallIdentity | null;
  }
}
