/**
 * Integration test against a REAL Postgres. Data is produced with the official
 * bullmq API (Postgres backend), so the rows are exactly what customers have.
 *
 * Each run creates its own schema (`bp_test_<random>`) and drops it at the end,
 * so it never touches anything else in the database. Point it at a server with
 * BULLPANE_TEST_PG_URL (default: the dev container on :5440, see
 * docs/POSTGRES.md). When nothing answers there, the suite is skipped with a
 * message rather than failing — CI provides the service explicitly.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { createPostgresBackend, FlowProducer, Queue, runMigrations, Worker, type Job } from "bullmq";
import { PgInspector, PgInspectorPool } from "../index.js";

const URL = process.env.BULLPANE_TEST_PG_URL ?? "postgres://postgres:bullpane@127.0.0.1:5440/bullpane";
const SCHEMA = `bp_test_${Math.random().toString(36).slice(2, 8)}`;
const PREVIEW = 200;

async function reachable(): Promise<boolean> {
  const client = new pg.Client({ connectionString: URL, connectionTimeoutMillis: 2000 });
  try {
    await client.connect();
    await client.end();
    return true;
  } catch {
    return false;
  }
}

const available = await reachable();
if (!available) {
  // An explicit URL (CI) means the database is supposed to be there: fail loudly.
  if (process.env.BULLPANE_TEST_PG_URL) throw new Error(`[pg-inspector] BULLPANE_TEST_PG_URL is set but ${URL} is unreachable`);
  console.warn(`[pg-inspector] no Postgres at ${URL}; integration suite skipped`);
}

const connection = { connectionString: URL, schema: SCHEMA, max: 4 };
const queues: Queue[] = [];
const workers: Worker[] = [];
let admin: pg.Pool;
let inspector: PgInspector;
let flowRootId: string;

function q(name: string): Queue {
  const queue = new Queue(name, { connection: connection as never }, createPostgresBackend as never);
  queues.push(queue);
  return queue;
}

function worker(name: string, fn: (job: Job) => Promise<unknown>, opts: Record<string, unknown> = {}): Worker {
  const w = new Worker(name, fn, { connection: connection as never, ...opts }, createPostgresBackend as never);
  w.on("error", () => undefined);
  workers.push(w);
  return w;
}

async function waitFor(pred: () => Promise<boolean>, ms = 15_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await pred()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("waitFor timed out");
}

describe.skipIf(!available)("PgInspector (real Postgres)", () => {
  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: URL, max: 2 });
    const client = await admin.connect();
    try {
      await runMigrations(client, SCHEMA);
    } finally {
      client.release();
    }

    // --- orders: waiting (one huge, one searchable), delayed, prioritized
    const orders = q("orders");
    for (let i = 0; i < 5; i++) await orders.add("order", { n: i, customer: `c${i}` });
    await orders.add("order", { n: 99, customer: "needle-xyz" });
    await orders.add("big", { blob: "x".repeat(60_000) });
    await orders.add("later", { n: 1 }, { delay: 3_600_000 });
    await orders.add("vip", { n: 2 }, { priority: 5 });

    // --- emails: completed + failed through a real worker, with metrics and logs
    const emails = q("emails");
    for (let i = 0; i < 4; i++) await emails.add("send", { i, fail: i === 3 }, { attempts: 1 });
    const w = worker(
      "emails",
      async (job) => {
        await job.log(`processing ${job.id}`);
        await job.updateProgress(50);
        if ((job.data as { fail: boolean }).fail) throw new Error("smtp down");
        return { sent: true };
      },
      { metrics: { maxDataPoints: 60 } },
    );
    await waitFor(async () => {
      const c = await emails.getJobCounts("completed", "failed");
      return c.completed === 3 && c.failed === 1;
    });
    await w.close();

    // --- reports: a job scheduler
    await q("reports").upsertJobScheduler("nightly", { pattern: "0 3 * * *" }, { name: "build", data: { kind: "nightly" } });

    // --- flows: parent in "assemble", children in "parts" (never processed: stays waiting-children).
    // No Queue is constructed for them on purpose: a FlowProducer writes no meta row.
    const flow = new FlowProducer({ connection: connection as never }, createPostgresBackend as never);
    const tree = await flow.add({
      name: "car",
      queueName: "assemble",
      data: {},
      children: [
        { name: "wheel", queueName: "parts", data: { n: 1 } },
        { name: "wheel", queueName: "parts", data: { n: 2 } },
        { name: "engine", queueName: "parts", data: {}, children: [{ name: "piston", queueName: "parts", data: {} }] },
      ],
    });
    flowRootId = String(tree.job.id);
    await flow.close();

    // --- paused queue with jobs still waiting
    const frozen = q("frozen");
    await frozen.add("x", {});
    await frozen.add("y", {});
    await frozen.pause();

    inspector = new PgInspector({ id: "t", kind: "postgres", url: URL, prefix: SCHEMA }, { previewBytes: PREVIEW, listFieldCapBytes: 32 * 1024 });
  });

  afterAll(async () => {
    await Promise.allSettled(workers.map((w) => w.close()));
    await Promise.allSettled(queues.map((qq) => qq.close()));
    await inspector?.close();
    await admin?.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    await admin?.end();
  });

  it("pings and reports the server version", async () => {
    const ping = await inspector.ping();
    expect(ping.ok).toBe(true);
    expect(ping.redisVersion).toMatch(/^\d+/);
  });

  it("explains a missing schema instead of failing on a missing table", async () => {
    const wrong = new PgInspector({ id: "w", kind: "postgres", url: URL, prefix: "no_such_schema" });
    const ping = await wrong.ping();
    expect(ping.ok).toBe(false);
    expect(ping.error).toMatch(/postgres_schema_missing/);
    await wrong.close();
  });

  it("discovers queues from meta and from jobs: one never given a job, and flow-only ones", async () => {
    const names = await inspector.discoverQueues({ force: true });
    expect(names).toEqual(expect.arrayContaining(["orders", "emails", "reports", "assemble", "parts", "frozen"]));
    expect(await inspector.discoveryStatus()).toMatchObject({ complete: true });
  });

  it("honours the queue filter", async () => {
    const filtered = new PgInspector({ id: "f", kind: "postgres", url: URL, prefix: SCHEMA, queueFilter: "e*" });
    expect(await filtered.discoverQueues()).toEqual(["emails"]);
    await filtered.close();
  });

  it("counts every state, splitting prioritized out of waiting", async () => {
    const stats = await inspector.getQueueStats(["orders", "emails", "frozen", "reports", "nope"], { withMetrics: true });
    expect(stats.orders?.counts).toMatchObject({ waiting: 7, prioritized: 1, delayed: 1, paused: 0 });
    expect(stats.emails?.counts).toMatchObject({ completed: 3, failed: 1, waiting: 0 });
    expect(stats.reports?.schedulersCount).toBe(1);
    expect(stats.nope?.counts.waiting).toBe(0);
  });

  it("shows a paused queue's jobs as waiting, with the queue flagged paused", async () => {
    const stats = await inspector.getQueueStats(["frozen"]);
    expect(stats.frozen).toMatchObject({ isPaused: true, counts: expect.objectContaining({ waiting: 2, paused: 0 }) });
  });

  it("reads success rates from BullMQ's metrics", async () => {
    const stats = await inspector.getQueueStats(["emails"]);
    expect(stats.emails?.rates).toMatchObject({ source: "metrics", completed: 3, failed: 1, successPct: 75 });
    expect(await inspector.getMetricsCounters("emails")).toMatchObject({ completed: 3, failed: 1 });
    expect(await inspector.getMetricsCounters("orders")).toMatchObject({ completed: null, failed: null });
  });

  it("windowed metrics and processing-time percentiles", async () => {
    const out = await inspector.getWindowMetrics([{ queue: "emails", rateWindows: [5, 60], durationWindows: [60] }]);
    expect(out.emails?.hasMetrics).toBe(true);
    expect(out.emails?.rates[1]).toMatchObject({ windowMinutes: 60, completed: 3, failed: 1 });
    expect(out.emails?.durations[0]?.sampled).toBe(3);
    expect(out.emails?.durations[0]?.p50Ms).not.toBeNull();
  });

  it("pages a state newest first, truncating payloads", async () => {
    const page = await inspector.getJobs("orders", "waiting", { start: 0, end: 2, order: "desc" });
    expect(page.total).toBe(7);
    expect(page.jobs).toHaveLength(3);
    const big = page.jobs[0]!;
    expect(big.name).toBe("big");
    expect(big.dataPreview).toHaveLength(PREVIEW);
    expect(big.dataTruncated).toBe(true);
    expect(big.dataBytes).toBeGreaterThan(60_000);

    const oldest = await inspector.getJobs("orders", "waiting", { start: 0, end: 0, order: "asc" });
    expect(oldest.jobs[0]?.dataPreview).toContain('"n": 0');

    const deep = await inspector.getJobs("orders", "waiting", { start: 6, end: 10, order: "desc" });
    expect(deep.jobs).toHaveLength(1);
  });

  it("reads delayed jobs with their due time, and prioritized jobs as prioritized", async () => {
    const delayed = await inspector.getJobs("orders", "delayed", { start: 0, end: 10, order: "desc" });
    expect(delayed.jobs[0]?.delayedUntil).toBeGreaterThan(Date.now() + 3_000_000);
    const prio = await inspector.getJobs("orders", "prioritized", { start: 0, end: 10, order: "desc" });
    expect(prio.jobs[0]).toMatchObject({ name: "vip", priority: 5, state: "prioritized" });
  });

  it("paused is always an empty state", async () => {
    expect(await inspector.getJobs("frozen", "paused", { start: 0, end: 10, order: "desc" })).toMatchObject({ total: 0, jobs: [] });
  });

  it("searches id, name, error and payload, case-insensitively, with a cursor", async () => {
    const hit = await inspector.searchJobs("orders", "waiting", "NEEDLE", { limit: 10 });
    expect(hit.jobs.map((j) => j.dataPreview)).toEqual([expect.stringContaining("needle-xyz")]);
    expect(hit.nextCursor).toBeNull();

    const err = await inspector.searchJobs("emails", "failed", "smtp", { limit: 10 });
    expect(err.jobs).toHaveLength(1);

    const literal = await inspector.searchJobs("orders", "waiting", "%", { limit: 10 });
    expect(literal.jobs).toHaveLength(0);

    const first = await inspector.searchJobs("orders", "waiting", "order", { limit: 2 });
    expect(first.jobs).toHaveLength(2);
    expect(first.nextCursor).not.toBeNull();
    const second = await inspector.searchJobs("orders", "waiting", "order", { cursor: first.nextCursor, limit: 10 });
    const ids = new Set([...first.jobs, ...second.jobs].map((j) => j.id));
    expect(ids.size).toBe(6);
  });

  it("job detail: data, opts, return value, logs, stacktrace", async () => {
    const completed = await inspector.getJobs("emails", "completed", { start: 0, end: 0, order: "desc" });
    const detail = await inspector.getJob("emails", completed.jobs[0]!.id);
    expect(detail).toMatchObject({ state: "completed", returnvalue: { sent: true }, progress: 50, logsCount: 1 });
    expect(detail?.logs[0]).toMatch(/^processing/);

    const failed = await inspector.getJobs("emails", "failed", { start: 0, end: 0, order: "desc" });
    const f = await inspector.getJob("emails", failed.jobs[0]!.id);
    expect(f?.failedReason).toBe("smtp down");
    expect(f?.stacktrace.length).toBeGreaterThan(0);

    expect(await inspector.getJob("emails", "does-not-exist")).toBeNull();
    const logs = await inspector.getJobLogs("emails", failed.jobs[0]!.id, { start: 0, end: -1 });
    expect(logs).toMatchObject({ count: 1 });
  });

  it("per-minute metric points, oldest first", async () => {
    const m = await inspector.getMetrics("emails", 10);
    expect(Array.isArray(m.completed)).toBe(true);
  });

  it("queue setup: meta, paused, metrics flag", async () => {
    const setup = await inspector.getQueueSetup("frozen");
    expect(setup).toMatchObject({ isPaused: true, groups: null, batch: "unknown" });
    const emails = await inspector.getQueueSetup("emails");
    expect(emails.metricsEnabled).toBe(true);
    expect(emails.workers).toMatchObject({ count: 0 });
  });

  it("sees a connected worker through pg_stat_activity", async () => {
    // A worker on a queue with nothing claimable: it only sits on its LISTEN connection.
    const w = worker("idle", async () => undefined, { name: "picker" });
    let seen: { count: number; names: string[] } | null = null;
    await waitFor(async () => {
      // a new inspector each time: getQueueSetup is cached for 10 s
      const fresh = new PgInspector({ id: "s", kind: "postgres", url: URL, prefix: SCHEMA });
      seen = (await fresh.getQueueSetup("idle")).workers;
      await fresh.close();
      return (seen?.count ?? 0) >= 1;
    });
    expect(seen).toEqual({ count: 1, names: ["picker"] });
    await w.close(true);
  });

  it("lists job schedulers with their template", async () => {
    const { schedulers, total } = await inspector.getSchedulers("reports", { start: 0, end: 10 });
    expect(total).toBe(1);
    expect(schedulers[0]).toMatchObject({ key: "nightly", pattern: "0 3 * * *", name: "build" });
    expect(schedulers[0]?.next).toBeGreaterThan(Date.now());
    expect(schedulers[0]?.template?.data).toContain("nightly");
  });

  it("samples flow edges and walks a flow tree from any node", async () => {
    const edges = await inspector.sampleFlowEdges("parts");
    expect(edges.edges).toEqual(expect.arrayContaining([expect.objectContaining({ parentQueue: "assemble", count: 3 })]));

    const tree = await inspector.getJobTree("assemble", flowRootId);
    expect(tree?.nodes).toHaveLength(5);
    expect(tree?.truncated).toBe(false);
    const root = tree?.nodes.find((n) => n.key === tree.rootKey);
    expect(root).toMatchObject({ state: "waiting-children", dependencies: { processed: 0, unprocessed: 3 } });

    const piston = tree!.nodes.find((n) => n.name === "piston")!;
    const fromLeaf = await inspector.getJobTree("parts", piston.id);
    expect(fromLeaf?.rootKey).toBe(tree?.rootKey);
    expect(fromLeaf?.climbedLevels).toBe(2);

    const capped = await inspector.getJobTree("assemble", flowRootId, { maxNodes: 2 });
    expect(capped?.nodes).toHaveLength(2);
    expect(capped?.truncated).toBe(true);
  });

  it("server info for the health monitor", async () => {
    const info = await inspector.serverInfo();
    expect(info).toMatchObject({ backend: "postgres", schema: SCHEMA });
    expect(info.jobTableBytes).toBeGreaterThan(0);
  });

  it("writes go through bullmq: add, promote, retry, remove, pause, clean, drain", async () => {
    const { id } = await inspector.addJob("writes", "w", { a: 1 }, { delay: 60_000 });
    await inspector.promoteJob("writes", id);
    expect((await inspector.getJob("writes", id))?.state).toBe("waiting");
    await inspector.removeJob("writes", id);
    expect(await inspector.getJob("writes", id)).toBeNull();

    const failed = await inspector.getJobs("emails", "failed", { start: 0, end: 0, order: "desc" });
    await inspector.retryJob("emails", failed.jobs[0]!.id);
    expect((await inspector.getJob("emails", failed.jobs[0]!.id))?.state).toBe("waiting");

    const bulk = await inspector.bulkJobAction("orders", "remove", ["missing-1", "missing-2"]);
    expect(bulk.failed).toHaveLength(2);

    await inspector.pauseQueue("orders");
    expect((await inspector.getQueueStats(["orders"])).orders?.isPaused).toBe(true);
    await inspector.resumeQueue("orders");

    const cleaned = await inspector.cleanQueue("emails", "completed", 0, 100);
    expect(cleaned.removed).toBe(3);

    await inspector.drainQueue("frozen", true);
    expect((await inspector.getQueueStats(["frozen"])).frozen?.counts.waiting).toBe(0);
  });

  it("discards an active job straight to failed, over the worker's lock", async () => {
    const stuck = q("stuck");
    const job = await stuck.add("hang", {}, { attempts: 5 });
    const w = worker("stuck", async () => new Promise(() => undefined));
    await waitFor(async () => (await inspector.getJob("stuck", String(job.id)))?.state === "active");
    expect((await inspector.getQueueStats(["stuck"])).stuck?.counts.active).toBe(1);
    await expect(inspector.discardJob("orders", (await inspector.getJobs("orders", "waiting", { start: 0, end: 0, order: "desc" })).jobs[0]!.id)).rejects.toThrow(
      /cannot_discard_job_in_state_waiting/,
    );
    await inspector.discardJob("stuck", String(job.id));
    const after = await inspector.getJob("stuck", String(job.id));
    expect(after).toMatchObject({ state: "failed", failedReason: "Discarded from Bullpane" });
    await w.close(true);
  });

  it("removes a job scheduler", async () => {
    expect(await inspector.removeScheduler("reports", "nightly")).toEqual({ removed: true });
    expect((await inspector.getSchedulers("reports", { start: 0, end: 10 })).total).toBe(0);
  });

  it("obliterates a queue and forgets it", async () => {
    await inspector.obliterateQueue("writes");
    expect(await inspector.discoverQueues({ force: true })).not.toContain("writes");
  });

  it("the pool keeps one inspector per id and replaces it when the target changes", async () => {
    const pool = new PgInspectorPool();
    const a = pool.get({ id: "x", kind: "postgres", url: URL, prefix: SCHEMA });
    expect(pool.get({ id: "x", kind: "postgres", url: URL, prefix: SCHEMA })).toBe(a);
    expect(pool.get({ id: "x", kind: "postgres", url: URL, prefix: "other" })).not.toBe(a);
    await pool.closeAll();
  });
});
