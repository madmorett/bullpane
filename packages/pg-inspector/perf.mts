import pg from "pg";
import { runMigrations } from "bullmq";
import { PgInspector } from "./src/index.js";
const URL = "postgres://postgres:bullpane@127.0.0.1:5440/bullpane";
const S = "bp_perf";
const admin = new pg.Pool({ connectionString: URL });
await admin.query(`DROP SCHEMA IF EXISTS ${S} CASCADE`);
const c = await admin.connect(); await runMigrations(c, S); c.release();
await admin.query(`
INSERT INTO ${S}.job (queue, id, seq, name, state, data, priority, added_at_ms, finished_at_ms, processed_at_ms, process_at_ms, failed_reason)
SELECT 'q' || (g % 20), g::text, g, 'job',
  (CASE WHEN g % 50 < 40 THEN 'completed' WHEN g % 50 < 45 THEN 'failed' WHEN g % 50 < 48 THEN 'waiting' WHEN g % 50 < 49 THEN 'delayed' ELSE 'waiting' END)::${S}.job_state,
  jsonb_build_object('n', g, 'customer', 'c' || g, 'pad', repeat('x', 200)),
  CASE WHEN g % 50 = 49 THEN 3 ELSE 0 END,
  1700000000000 + g, CASE WHEN g % 50 < 45 THEN 1700000000000 + g * 10 END, 1700000000000 + g,
  CASE WHEN g % 50 = 48 THEN 1800000000000 + g END,
  CASE WHEN g % 50 BETWEEN 40 AND 44 THEN 'boom ' || g END
FROM generate_series(1, 1000000) g`);
await admin.query(`VACUUM ANALYZE ${S}.job`);
const ins = new PgInspector({ id: "p", kind: "postgres", url: URL, prefix: S });
async function time(label: string, fn: () => Promise<unknown>, n = 5) {
  await fn(); const ts: number[] = [];
  for (let i = 0; i < n; i++) { const a = performance.now(); await fn(); ts.push(performance.now() - a); }
  ts.sort((a, b) => a - b); console.log(label.padEnd(44), "p50", ts[Math.floor(n / 2)]!.toFixed(1), "ms");
}
const names = Array.from({ length: 20 }, (_, i) => `q${i}`);
await time("getQueueStats 20 queues (after VACUUM)", () => ins.getQueueStats(names, { withMetrics: true }));
await time("getJobs completed page 1", () => ins.getJobs("q1", "completed", { start: 0, end: 49, order: "desc" }));
await time("getJobs completed offset 39k", () => ins.getJobs("q1", "completed", { start: 39_000, end: 39_049, order: "desc" }));
await time("searchJobs completed (miss)", () => ins.searchJobs("q1", "completed", "zzz-nope", { limit: 25 }));
for (const sql of [`SELECT count(*) FROM job WHERE queue='q1' AND state='completed'`,
  `SELECT id, row_number() OVER (ORDER BY finished_at_ms DESC) FROM job WHERE queue='q1' AND state='completed' ORDER BY finished_at_ms DESC OFFSET 0 LIMIT 50`]) {
  const r = await admin.query(`SET search_path=${S}; EXPLAIN (ANALYZE) ${sql}`);
  console.log((r as any)[1].rows.map((x: any) => x["QUERY PLAN"]).slice(0, 6).join("\n"));
}
await ins.close(); await admin.end();
