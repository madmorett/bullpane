/**
 * Tiny SQL migrator. Applies migrations/*.sql in filename order, once each,
 * tracked in `_migrations`. Statements are split on ";\n".
 */
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { MysqlPool, WaitLogger } from "./index";
import { SERVER_ROOT } from "../config";

export const MIGRATIONS_DIR = path.resolve(SERVER_ROOT, "migrations");

export function splitStatements(sql: string): string[] {
  const withoutComments = sql
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n");
  return withoutComments
    .split(/;\s*\n/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export async function runMigrations(
  pool: MysqlPool,
  log: WaitLogger,
  dir: string = MIGRATIONS_DIR,
): Promise<{ applied: string[] }> {
  await pool.query(
    "CREATE TABLE IF NOT EXISTS _migrations (" +
      "name VARCHAR(255) NOT NULL PRIMARY KEY, " +
      "applied_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)" +
      ") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",
  );
  const [rows] = await pool.query<import("mysql2").RowDataPacket[]>("SELECT name FROM _migrations");
  const done = new Set(rows.map((r) => String(r.name)));

  const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
  const applied: string[] = [];
  for (const file of files) {
    if (done.has(file)) continue;
    const sql = await readFile(path.join(dir, file), "utf8");
    log.info(`Applying migration ${file}`);
    for (const statement of splitStatements(sql)) {
      await pool.query(statement);
    }
    await pool.query("INSERT INTO _migrations (name) VALUES (?)", [file]);
    applied.push(file);
  }
  return { applied };
}
