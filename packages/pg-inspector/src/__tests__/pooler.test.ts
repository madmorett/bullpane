/**
 * Behind a transaction pooler (PgBouncer, Supavisor, RDS Proxy): no session
 * state survives between transactions, and startup options are refused or
 * dropped. Needs the pooler(s) in front of the database the main suite uses:
 *
 *   BULLPANE_TEST_PG_POOLER_URLS=postgres://postgres:bullpane@127.0.0.1:6433/bullpane,postgres://…:6434/bullpane
 *
 * (apps/smoke starts PgBouncer in both configurations when Docker is available.)
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { createPostgresBackend, Queue, runMigrations } from "bullmq";
import { PgInspector } from "../index.js";

const DIRECT = process.env.BULLPANE_TEST_PG_URL ?? "postgres://postgres:bullpane@127.0.0.1:5440/bullpane";
const POOLERS = (process.env.BULLPANE_TEST_PG_POOLER_URLS ?? "").split(",").filter(Boolean);
const run = Math.random().toString(36).slice(2, 7);
/** two schemas with different contents: a read served by the wrong one shows */
const SCHEMAS = { [`pool_a_${run}`]: 3, [`pool_b_${run}`]: 8 } as Record<string, number>;

describe.skipIf(POOLERS.length === 0)("behind a transaction pooler", () => {
  beforeAll(async () => {
    for (const [schema, n] of Object.entries(SCHEMAS)) {
      const c = new pg.Client({ connectionString: DIRECT });
      await c.connect();
      await runMigrations(c as never, schema);
      await c.end();
      const q = new Queue("orders", { connection: { connectionString: DIRECT, schema } as never }, createPostgresBackend as never);
      for (let i = 0; i < n; i++) await q.add("o", { i });
      await q.close();
    }
  });

  afterAll(async () => {
    const c = new pg.Client({ connectionString: DIRECT });
    await c.connect();
    for (const schema of Object.keys(SCHEMAS)) await c.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await c.end();
  });

  for (const url of POOLERS) {
    const port = new URL(url).port;

    it(`:${port} — falls back to transaction mode and reads work`, async () => {
      const [schema] = Object.keys(SCHEMAS);
      const ins = new PgInspector({ id: "p", kind: "postgres", url, prefix: schema });
      try {
        expect((await ins.ping()).ok).toBe(true);
        expect(await ins.connectionMode()).toBe("transaction");
        expect((await ins.getQueueStats(["orders"])).orders?.counts.waiting).toBe(SCHEMAS[schema!]);
        expect(await ins.discoverQueues()).toEqual(["orders"]);
        expect((await ins.searchJobs("orders", "waiting", '"i": 1', { limit: 5 })).jobs).toHaveLength(1);
        expect((await ins.serverInfo()).backend).toBe("postgres");
      } finally {
        await ins.close();
      }
    });

    it(`:${port} — concurrent reads of two schemas never cross (no session state leaks)`, async () => {
      const inspectors = Object.keys(SCHEMAS).map((schema) => ({ schema, ins: new PgInspector({ id: schema, kind: "postgres", url, prefix: schema }) }));
      try {
        const wrong: string[] = [];
        for (let round = 0; round < 20; round++) {
          await Promise.all(
            inspectors.flatMap(({ schema, ins }) =>
              Array.from({ length: 3 }, async () => {
                const page = await ins.getJobs("orders", "waiting", { start: 0, end: 50, order: "desc" });
                if (page.jobs.length !== SCHEMAS[schema]) wrong.push(`${schema}: ${page.jobs.length}`);
              }),
            ),
          );
        }
        expect(wrong).toEqual([]);
      } finally {
        for (const { ins } of inspectors) await ins.close();
      }
    });

    it(`:${port} — writes through bullmq land in the right schema`, async () => {
      const [, schema] = Object.keys(SCHEMAS);
      const ins = new PgInspector({ id: "w", kind: "postgres", url, prefix: schema });
      try {
        const { id } = await ins.addJob("orders", "via-pooler", { port });
        const c = new pg.Client({ connectionString: DIRECT });
        await c.connect();
        const { rows } = await c.query(`SELECT name FROM "${schema}".job WHERE queue = 'orders' AND id = $1`, [id]);
        await c.end();
        expect(rows).toEqual([{ name: "via-pooler" }]);
        await ins.removeJob("orders", id);
      } finally {
        await ins.close();
      }
    });
  }
});
