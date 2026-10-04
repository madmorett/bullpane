/**
 * Drizzle schema, SQLite dialect — the zero-setup default when DATABASE_URL is
 * not set. Same tables, same column names and same TypeScript row types as
 * schema.mysql.ts; the assertions at the bottom fail the typecheck the moment
 * the two drift. Mirrors migrations/sqlite/*.sql.
 *
 * Type mapping: DATETIME(3) → INTEGER epoch ms (`timestamp_ms`, keeps the
 * millisecond the audit cursor pages on), TINYINT(1) → INTEGER boolean,
 * JSON → TEXT parsed by drizzle, ENUM/VARCHAR → TEXT. Lengths are not enforced
 * by SQLite; inputs are bounded by the zod schemas before they get here.
 */
import type { AlertChannel, AlertCondition, AlertEventStatus, AlertKind, AuditAction, AuditResult, ConnectionKind, McpGrantAccess, Role, SsoKind } from "@bullpane/shared";
import { index, integer, primaryKey, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import type * as mysql from "./schema.mysql";

const id = () => text("id").primaryKey();
const timestamp = (name: string) => integer(name, { mode: "timestamp_ms" });
const createdAt = () => timestamp("created_at").notNull();
const bool = (name: string) => integer(name, { mode: "boolean" });

export const users = sqliteTable(
  "users",
  {
    id: id(),
    email: text("email").notNull(),
    name: text("name").notNull(),
    passwordHash: text("password_hash"),
    role: text("role", { enum: ["admin", "operator", "viewer"] }).notNull().default("viewer"),
    createdAt: createdAt(),
    lastLoginAt: timestamp("last_login_at"),
    disabledAt: timestamp("disabled_at"),
  },
  (t) => [uniqueIndex("users_email_unique").on(t.email)],
);

export const sessions = sqliteTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    expiresAt: timestamp("expires_at").notNull(),
    createdAt: createdAt(),
    authMethod: text("auth_method", { enum: ["password", "sso"] }).notNull().default("password"),
  },
  (t) => [index("sessions_user_id_idx").on(t.userId), index("sessions_expires_at_idx").on(t.expiresAt)],
);

export const ssoProviders = sqliteTable(
  "sso_providers",
  {
    id: id(),
    kind: text("kind").$type<SsoKind>().notNull(),
    name: text("name").notNull(),
    enabled: bool("enabled").notNull().default(true),
    config: text("config", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
    secretEnc: text("secret_enc"),
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at").notNull(),
  },
  (t) => [index("sso_providers_enabled_idx").on(t.enabled)],
);

export const connections = sqliteTable("connections", {
  id: id(),
  name: text("name").notNull(),
  kind: text("kind").$type<ConnectionKind>().notNull().default("redis"),
  url: text("url").notNull(),
  prefix: text("prefix").notNull().default("bull"),
  cluster: bool("cluster").notNull().default(false),
  queueFilter: text("queue_filter"),
  position: integer("position").notNull().default(0),
  createdAt: createdAt(),
});

export const folders = sqliteTable(
  "folders",
  {
    id: id(),
    name: text("name").notNull(),
    color: text("color"),
    parentId: text("parent_id"),
    position: integer("position").notNull().default(0),
  },
  (t) => [index("folders_parent_id_idx").on(t.parentId)],
);

export const folderQueues = sqliteTable(
  "folder_queues",
  {
    folderId: text("folder_id")
      .notNull()
      .references(() => folders.id, { onDelete: "cascade" }),
    connectionId: text("connection_id").notNull(),
    queueName: text("queue_name").notNull(),
  },
  (t) => [primaryKey({ columns: [t.folderId, t.connectionId, t.queueName] })],
);

export const hiddenQueues = sqliteTable(
  "hidden_queues",
  {
    connectionId: text("connection_id").notNull(),
    queueName: text("queue_name").notNull(),
    hiddenAt: timestamp("hidden_at").notNull(),
    hiddenBy: text("hidden_by"),
  },
  (t) => [primaryKey({ columns: [t.connectionId, t.queueName] })],
);

export const alerts = sqliteTable(
  "alerts",
  {
    id: id(),
    name: text("name").notNull(),
    enabled: bool("enabled").notNull().default(true),
    scopeType: text("scope_type", { enum: ["queue", "folder", "connection", "global"] }).notNull().default("queue"),
    connectionId: text("connection_id"),
    queueName: text("queue_name"),
    folderId: text("folder_id"),
    condition: text("condition", { mode: "json" }).$type<AlertCondition>().notNull(),
    channels: text("channels", { mode: "json" }).$type<AlertChannel[]>().notNull(),
    cooldownMinutes: integer("cooldown_minutes").notNull().default(30),
    createdAt: createdAt(),
    lastFiredAt: timestamp("last_fired_at"),
    firing: bool("firing").notNull().default(false),
  },
  (t) => [index("alerts_connection_id_idx").on(t.connectionId), index("alerts_folder_id_idx").on(t.folderId)],
);

export const alertEvents = sqliteTable(
  "alert_events",
  {
    id: id(),
    alertId: text("alert_id").notNull(),
    alertName: text("alert_name").notNull(),
    connectionId: text("connection_id"),
    queueName: text("queue_name"),
    kind: text("kind").$type<AlertKind>().notNull(),
    status: text("status").$type<AlertEventStatus>().notNull(),
    message: text("message").notNull(),
    value: real("value"),
    createdAt: createdAt(),
  },
  (t) => [index("alert_events_created_at_idx").on(t.createdAt), index("alert_events_alert_id_idx").on(t.alertId)],
);

export const auditLog = sqliteTable(
  "audit_log",
  {
    id: id(),
    createdAt: createdAt(),
    actorId: text("actor_id"),
    actorEmail: text("actor_email"),
    actorName: text("actor_name"),
    actorRole: text("actor_role").$type<Role>(),
    action: text("action").$type<AuditAction>().notNull(),
    connectionId: text("connection_id"),
    connectionName: text("connection_name"),
    queueName: text("queue_name"),
    jobId: text("job_id"),
    result: text("result").$type<AuditResult>().notNull().default("ok"),
    errorMessage: text("error_message"),
    detail: text("detail", { mode: "json" }).$type<Record<string, unknown>>(),
    ip: text("ip"),
    userAgent: text("user_agent"),
  },
  (t) => [
    index("audit_log_created_at_idx").on(t.createdAt, t.id),
    index("audit_log_actor_id_idx").on(t.actorId),
    index("audit_log_queue_idx").on(t.connectionId, t.queueName),
  ],
);

export const flowEdges = sqliteTable(
  "flow_edges",
  {
    id: id(),
    connectionId: text("connection_id").notNull(),
    fromQueue: text("from_queue").notNull(),
    toQueue: text("to_queue").notNull(),
    label: text("label"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("flow_edges_unique").on(t.connectionId, t.fromQueue, t.toQueue)],
);

/** MCP OAuth — see migrations/mysql/0009_mcp.sql for the design. */
export const mcpClients = sqliteTable(
  "mcp_clients",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    redirectUris: text("redirect_uris", { mode: "json" }).$type<string[]>().notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("mcp_clients_created_at_idx").on(t.createdAt)],
);

export const mcpAuthCodes = sqliteTable(
  "mcp_auth_codes",
  {
    codeHash: text("code_hash").primaryKey(),
    clientId: text("client_id")
      .notNull()
      .references(() => mcpClients.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    access: text("access").$type<McpGrantAccess>().notNull(),
    redirectUri: text("redirect_uri").notNull(),
    codeChallenge: text("code_challenge").notNull(),
    expiresAt: timestamp("expires_at").notNull(),
  },
  (t) => [index("mcp_auth_codes_expires_at_idx").on(t.expiresAt)],
);

export const mcpGrants = sqliteTable(
  "mcp_grants",
  {
    id: id(),
    clientId: text("client_id")
      .notNull()
      .references(() => mcpClients.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    access: text("access").$type<McpGrantAccess>().notNull(),
    refreshHash: text("refresh_hash").notNull(),
    prevRefreshHash: text("prev_refresh_hash"),
    refreshExpiresAt: timestamp("refresh_expires_at").notNull(),
    createdAt: createdAt(),
    lastUsedAt: timestamp("last_used_at"),
  },
  (t) => [
    uniqueIndex("mcp_grants_refresh_hash_unique").on(t.refreshHash),
    index("mcp_grants_prev_refresh_hash_idx").on(t.prevRefreshHash),
    index("mcp_grants_user_id_idx").on(t.userId),
  ],
);

export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});

// --- drift guard -----------------------------------------------------------
// The server codes against the MySQL row types. If a column is added, renamed
// or retyped on one side only, one of these lines stops compiling.
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type Assert<T extends true> = T;
type Row<T extends { $inferSelect: unknown }> = T["$inferSelect"];
type Insert<T extends { $inferInsert: unknown }> = T["$inferInsert"];

export type _DriftGuard = [
  Assert<Same<Row<typeof users>, Row<typeof mysql.users>>>,
  Assert<Same<Insert<typeof users>, Insert<typeof mysql.users>>>,
  Assert<Same<Row<typeof sessions>, Row<typeof mysql.sessions>>>,
  Assert<Same<Insert<typeof sessions>, Insert<typeof mysql.sessions>>>,
  Assert<Same<Row<typeof ssoProviders>, Row<typeof mysql.ssoProviders>>>,
  Assert<Same<Insert<typeof ssoProviders>, Insert<typeof mysql.ssoProviders>>>,
  Assert<Same<Row<typeof connections>, Row<typeof mysql.connections>>>,
  Assert<Same<Insert<typeof connections>, Insert<typeof mysql.connections>>>,
  Assert<Same<Row<typeof folders>, Row<typeof mysql.folders>>>,
  Assert<Same<Insert<typeof folders>, Insert<typeof mysql.folders>>>,
  Assert<Same<Row<typeof folderQueues>, Row<typeof mysql.folderQueues>>>,
  Assert<Same<Insert<typeof folderQueues>, Insert<typeof mysql.folderQueues>>>,
  Assert<Same<Row<typeof hiddenQueues>, Row<typeof mysql.hiddenQueues>>>,
  Assert<Same<Insert<typeof hiddenQueues>, Insert<typeof mysql.hiddenQueues>>>,
  Assert<Same<Row<typeof alerts>, Row<typeof mysql.alerts>>>,
  Assert<Same<Insert<typeof alerts>, Insert<typeof mysql.alerts>>>,
  Assert<Same<Row<typeof alertEvents>, Row<typeof mysql.alertEvents>>>,
  Assert<Same<Insert<typeof alertEvents>, Insert<typeof mysql.alertEvents>>>,
  Assert<Same<Row<typeof auditLog>, Row<typeof mysql.auditLog>>>,
  Assert<Same<Insert<typeof auditLog>, Insert<typeof mysql.auditLog>>>,
  Assert<Same<Row<typeof flowEdges>, Row<typeof mysql.flowEdges>>>,
  Assert<Same<Insert<typeof flowEdges>, Insert<typeof mysql.flowEdges>>>,
  Assert<Same<Row<typeof settings>, Row<typeof mysql.settings>>>,
  Assert<Same<Insert<typeof settings>, Insert<typeof mysql.settings>>>,
  Assert<Same<Row<typeof mcpClients>, Row<typeof mysql.mcpClients>>>,
  Assert<Same<Insert<typeof mcpClients>, Insert<typeof mysql.mcpClients>>>,
  Assert<Same<Row<typeof mcpAuthCodes>, Row<typeof mysql.mcpAuthCodes>>>,
  Assert<Same<Insert<typeof mcpAuthCodes>, Insert<typeof mysql.mcpAuthCodes>>>,
  Assert<Same<Row<typeof mcpGrants>, Row<typeof mysql.mcpGrants>>>,
  Assert<Same<Insert<typeof mcpGrants>, Insert<typeof mysql.mcpGrants>>>,
];
