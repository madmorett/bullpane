/**
 * Drizzle schema. Mirrors migrations/*.sql — the SQL files are the source of
 * truth for the database; this file is the typed view the server codes against.
 */
import type { AlertChannel, AlertCondition, AlertEventStatus, AlertKind, AuditAction, AuditResult, Role, SsoKind } from "@bullpane/shared";
import {
  boolean,
  datetime,
  double,
  index,
  int,
  json,
  mysqlEnum,
  mysqlTable,
  primaryKey,
  text,
  uniqueIndex,
  varchar,
} from "drizzle-orm/mysql-core";

const id = () => varchar("id", { length: 36 }).primaryKey();
const createdAt = () => datetime("created_at", { mode: "date", fsp: 3 }).notNull();

export const users = mysqlTable(
  "users",
  {
    id: id(),
    email: varchar("email", { length: 255 }).notNull(),
    name: varchar("name", { length: 80 }).notNull(),
    /**
     * NULL for an account that only signs in through SSO. `verifyPassword`
     * refuses a NULL hash, so such a user cannot use the password form at all.
     */
    passwordHash: varchar("password_hash", { length: 255 }),
    role: mysqlEnum("role", ["admin", "operator", "viewer"]).notNull().default("viewer"),
    createdAt: createdAt(),
    lastLoginAt: datetime("last_login_at", { mode: "date", fsp: 3 }),
    /**
     * Set when an admin disables the account — see migrations/0007_user_disabled.sql
     * for why users are disabled and never deleted. A disabled user cannot log in
     * (password or SSO) and has no live session; the row and its id stay so the
     * audit log and everything else that names this person keep resolving.
     */
    disabledAt: datetime("disabled_at", { mode: "date", fsp: 3 }),
  },
  (t) => [uniqueIndex("users_email_unique").on(t.email)],
);

export const sessions = mysqlTable(
  "sessions",
  {
    id: varchar("id", { length: 64 }).primaryKey(),
    userId: varchar("user_id", { length: 36 })
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    expiresAt: datetime("expires_at", { mode: "date", fsp: 3 }).notNull(),
    createdAt: createdAt(),
    /** How this session was authenticated. Drives the audit wording. */
    authMethod: mysqlEnum("auth_method", ["password", "sso"]).notNull().default("password"),
  },
  (t) => [index("sessions_user_id_idx").on(t.userId), index("sessions_expires_at_idx").on(t.expiresAt)],
);

/**
 * SSO providers — see migrations/0005_sso.sql for why `config` is JSON and why
 * the secret is encrypted rather than hashed.
 */
export const ssoProviders = mysqlTable(
  "sso_providers",
  {
    id: id(),
    kind: varchar("kind", { length: 10 }).$type<SsoKind>().notNull(),
    name: varchar("name", { length: 60 }).notNull(),
    enabled: boolean("enabled").notNull().default(true),
    config: json("config").$type<Record<string, unknown>>().notNull(),
    /** AES-256-GCM, keyed off SESSION_SECRET. NULL for SAML. Never leaves the server. */
    secretEnc: text("secret_enc"),
    createdAt: createdAt(),
    updatedAt: datetime("updated_at", { mode: "date", fsp: 3 }).notNull(),
  },
  (t) => [index("sso_providers_enabled_idx").on(t.enabled)],
);

export const connections = mysqlTable("connections", {
  id: id(),
  name: varchar("name", { length: 80 }).notNull(),
  url: text("url").notNull(),
  prefix: varchar("prefix", { length: 64 }).notNull().default("bull"),
  cluster: boolean("cluster").notNull().default(false),
  queueFilter: varchar("queue_filter", { length: 200 }),
  /** Manual sidebar order, global (not per user). Same semantics as `folders.position`. */
  position: int("position").notNull().default(0),
  createdAt: createdAt(),
});

export const folders = mysqlTable(
  "folders",
  {
    id: id(),
    name: varchar("name", { length: 80 }).notNull(),
    color: varchar("color", { length: 20 }),
    parentId: varchar("parent_id", { length: 36 }),
    position: int("position").notNull().default(0),
  },
  (t) => [index("folders_parent_id_idx").on(t.parentId)],
);

export const folderQueues = mysqlTable(
  "folder_queues",
  {
    folderId: varchar("folder_id", { length: 36 })
      .notNull()
      .references(() => folders.id, { onDelete: "cascade" }),
    connectionId: varchar("connection_id", { length: 36 }).notNull(),
    queueName: varchar("queue_name", { length: 255 }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.folderId, t.connectionId, t.queueName] })],
);

/**
 * Hidden queues — see migrations/0003_hidden_queues.sql.
 * Scope is the INSTANCE, not the user: presence of the row hides the queue for
 * everyone. Row shape mirrors folder_queues (connection id + discovered queue
 * name, no FK to a queue table because queues are not rows).
 */
export const hiddenQueues = mysqlTable(
  "hidden_queues",
  {
    connectionId: varchar("connection_id", { length: 36 }).notNull(),
    queueName: varchar("queue_name", { length: 255 }).notNull(),
    hiddenAt: datetime("hidden_at", { mode: "date", fsp: 3 }).notNull(),
    hiddenBy: varchar("hidden_by", { length: 36 }),
  },
  (t) => [primaryKey({ columns: [t.connectionId, t.queueName] })],
);

export const alerts = mysqlTable(
  "alerts",
  {
    id: id(),
    name: varchar("name", { length: 120 }).notNull(),
    enabled: boolean("enabled").notNull().default(true),
    scopeType: mysqlEnum("scope_type", ["queue", "folder"]).notNull().default("queue"),
    connectionId: varchar("connection_id", { length: 36 }),
    queueName: varchar("queue_name", { length: 255 }),
    folderId: varchar("folder_id", { length: 36 }),
    condition: json("condition").$type<AlertCondition>().notNull(),
    channels: json("channels").$type<AlertChannel[]>().notNull(),
    cooldownMinutes: int("cooldown_minutes").notNull().default(30),
    createdAt: createdAt(),
    lastFiredAt: datetime("last_fired_at", { mode: "date", fsp: 3 }),
    firing: boolean("firing").notNull().default(false),
  },
  (t) => [index("alerts_connection_id_idx").on(t.connectionId), index("alerts_folder_id_idx").on(t.folderId)],
);

export const alertEvents = mysqlTable(
  "alert_events",
  {
    id: id(),
    alertId: varchar("alert_id", { length: 36 }).notNull(),
    alertName: varchar("alert_name", { length: 120 }).notNull(),
    connectionId: varchar("connection_id", { length: 36 }),
    queueName: varchar("queue_name", { length: 255 }),
    kind: varchar("kind", { length: 40 }).$type<AlertKind>().notNull(),
    status: varchar("status", { length: 20 }).$type<AlertEventStatus>().notNull(),
    message: text("message").notNull(),
    value: double("value"),
    createdAt: createdAt(),
  },
  (t) => [index("alert_events_created_at_idx").on(t.createdAt), index("alert_events_alert_id_idx").on(t.alertId)],
);

/**
 * Audit log — see migrations/0004_audit_log.sql.
 *
 * Append-only. The actor and the connection are DENORMALISED on purpose (no FK
 * to `users`, none to `connections`): a trail that points at a deleted row is
 * worthless exactly when it matters, and "the person who did it is gone" is the
 * normal case in an audit. `detail` holds action parameters only — never a job
 * payload (CLAUDE.md: never log job data).
 */
export const auditLog = mysqlTable(
  "audit_log",
  {
    id: id(),
    createdAt: createdAt(),
    actorId: varchar("actor_id", { length: 36 }),
    actorEmail: varchar("actor_email", { length: 255 }),
    actorName: varchar("actor_name", { length: 80 }),
    actorRole: varchar("actor_role", { length: 20 }).$type<Role>(),
    action: varchar("action", { length: 40 }).$type<AuditAction>().notNull(),
    connectionId: varchar("connection_id", { length: 36 }),
    connectionName: varchar("connection_name", { length: 80 }),
    queueName: varchar("queue_name", { length: 255 }),
    jobId: varchar("job_id", { length: 255 }),
    result: varchar("result", { length: 10 }).$type<AuditResult>().notNull().default("ok"),
    errorMessage: varchar("error_message", { length: 500 }),
    detail: json("detail").$type<Record<string, unknown>>(),
    ip: varchar("ip", { length: 45 }),
    userAgent: varchar("user_agent", { length: 255 }),
  },
  (t) => [
    // Keyset paging + ordering in one index.
    index("audit_log_created_at_idx").on(t.createdAt, t.id),
    index("audit_log_actor_id_idx").on(t.actorId),
    index("audit_log_queue_idx").on(t.connectionId, t.queueName),
  ],
);

export const flowEdges = mysqlTable(
  "flow_edges",
  {
    id: id(),
    connectionId: varchar("connection_id", { length: 36 }).notNull(),
    fromQueue: varchar("from_queue", { length: 255 }).notNull(),
    toQueue: varchar("to_queue", { length: 255 }).notNull(),
    label: varchar("label", { length: 120 }),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("flow_edges_unique").on(t.connectionId, t.fromQueue, t.toQueue)],
);

export const settings = mysqlTable("settings", {
  key: varchar("key", { length: 64 }).primaryKey(),
  value: text("value").notNull(),
});

export type UserRow = typeof users.$inferSelect;
export type SessionRow = typeof sessions.$inferSelect;
export type SsoProviderRow = typeof ssoProviders.$inferSelect;
export type ConnectionRow = typeof connections.$inferSelect;
export type FolderRow = typeof folders.$inferSelect;
export type FolderQueueRow = typeof folderQueues.$inferSelect;
export type HiddenQueueRow = typeof hiddenQueues.$inferSelect;
export type AlertRow = typeof alerts.$inferSelect;
export type AlertEventRow = typeof alertEvents.$inferSelect;
export type FlowEdgeRow = typeof flowEdges.$inferSelect;
export type AuditLogRow = typeof auditLog.$inferSelect;
