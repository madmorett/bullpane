/**
 * @bullpane/pg-inspector
 *
 * The Inspector for BullMQ's PostgreSQL backend (BullMQ >= 6): reads are SQL
 * against BullMQ's own schema, writes go through the official bullmq API.
 */
export { PgInspector } from "./inspector.js";
export { PgInspectorPool } from "./pool.js";
