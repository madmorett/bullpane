import { drizzle, type MySql2Database } from "drizzle-orm/mysql2";
import mysql from "mysql2/promise";
import * as schema from "./schema";

export type Db = MySql2Database<typeof schema>;
export type MysqlPool = mysql.Pool;

export interface Database {
  db: Db;
  pool: MysqlPool;
  close(): Promise<void>;
}

export function createDatabase(databaseUrl: string): Database {
  const pool = mysql.createPool({
    uri: databaseUrl,
    connectionLimit: 10,
    waitForConnections: true,
    timezone: "Z",
    supportBigNumbers: true,
    charset: "utf8mb4",
  });
  const db = drizzle(pool, { schema, mode: "default" });
  return {
    db,
    pool,
    close: () => pool.end(),
  };
}

export interface WaitLogger {
  info(msg: string): void;
  warn(msg: string): void;
}

/**
 * docker compose starts MySQL slowly. Retry the handshake for up to
 * `timeoutMs` (60 s), logging once every `intervalMs` (2 s).
 */
export async function waitForDatabase(
  pool: MysqlPool,
  log: WaitLogger,
  opts: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const intervalMs = opts.intervalMs ?? 2_000;
  const startedAt = Date.now();
  let lastError: unknown = null;
  while (Date.now() - startedAt < timeoutMs) {
    try {
      await pool.query("SELECT 1");
      return;
    } catch (err) {
      lastError = err;
      const elapsed = Math.round((Date.now() - startedAt) / 1000);
      log.info(`MySQL not reachable yet (${elapsed}s): ${errorMessage(err)}. Retrying in ${intervalMs / 1000}s...`);
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  }
  throw new Error(`MySQL did not become reachable within ${timeoutMs / 1000}s: ${errorMessage(lastError)}`);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export { schema };
