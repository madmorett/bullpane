/**
 * Drizzle schema. Mirrors migrations/*.sql — the SQL files are the source of
 * truth for the database; this file is the typed view the server codes against.
 */
import type { AlertChannel, AlertCondition, AlertKind } from "@bullmq-visualizer/shared";
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
    passwordHash: varchar("password_hash", { length: 255 }).notNull(),
    role: mysqlEnum("role", ["admin", "operator", "viewer"]).notNull().default("viewer"),
    createdAt: createdAt(),
    lastLoginAt: datetime("last_login_at", { mode: "date", fsp: 3 }),
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
  },
  (t) => [index("sessions_user_id_idx").on(t.userId), index("sessions_expires_at_idx").on(t.expiresAt)],
);

export const connections = mysqlTable("connections", {
  id: id(),
  name: varchar("name", { length: 80 }).notNull(),
  url: text("url").notNull(),
  prefix: varchar("prefix", { length: 64 }).notNull().default("bull"),
  cluster: boolean("cluster").notNull().default(false),
  queueFilter: varchar("queue_filter", { length: 200 }),
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
    status: varchar("status", { length: 20 }).$type<"fired" | "resolved" | "delivery_failed">().notNull(),
    message: text("message").notNull(),
    value: double("value"),
    createdAt: createdAt(),
  },
  (t) => [index("alert_events_created_at_idx").on(t.createdAt), index("alert_events_alert_id_idx").on(t.alertId)],
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
export type ConnectionRow = typeof connections.$inferSelect;
export type FolderRow = typeof folders.$inferSelect;
export type FolderQueueRow = typeof folderQueues.$inferSelect;
export type AlertRow = typeof alerts.$inferSelect;
export type AlertEventRow = typeof alertEvents.$inferSelect;
export type FlowEdgeRow = typeof flowEdges.$inferSelect;
