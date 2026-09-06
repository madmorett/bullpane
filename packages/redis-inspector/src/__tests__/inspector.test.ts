/**
 * Integration test against a REAL redis-server on port 6399 (never the dev one on 6379).
 * Data is produced with the official bullmq API so the key layout is exactly what
 * customers have. Pro group keys are written by hand (no Pro token here).
 */
import { execSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Redis from "ioredis";
import { FlowProducer, Queue, Worker, type Job } from "bullmq";
import {
  RedisInspector,
  RedisInspectorPool,
  globToRegExp,
  parseQueueNameFromMetaKey,
  queueNameFromQueueKey,
} from "../index.js";

const PORT = 6399;
const URL = `redis://127.0.0.1:${PORT}`;
const connection = { host: "127.0.0.1", port: PORT };
const PREVIEW = 200;

let raw: Redis;
let inspector: RedisInspector;
const queues: Queue[] = [];
const workers: Worker[] = [];

function q(name: string): Queue {
  const queue = new Queue(name, { connection });
  queues.push(queue);
  return queue;
}

async function waitFor(pred: () => Promise<boolean>, ms = 15_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await pred()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("waitFor timed out");
}

function redisCli(args: string): string {
  return execSync(`redis-cli -p ${PORT} ${args}`, { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
}

beforeAll(async () => {
  // a stale instance from an aborted run would make the new one fail silently
  try {
    redisCli("shutdown nosave");
  } catch {
    /* not running */
  }
  execSync(`redis-server --port ${PORT} --save "" --appendonly no --daemonize yes`, { stdio: "ignore" });
  await waitFor(async () => {
    try {
      return redisCli("ping") === "PONG";
    } catch {
      return false;
    }
  }, 10_000);

  raw = new Redis(URL);
  await raw.flushall();

  // --- orders: waiting (incl. one huge payload + one searchable), delayed, prioritized
  const orders = q("orders");
  for (let i = 0; i < 5; i++) await orders.add("order", { n: i, customer: `c${i}` });
  await orders.add("order", { n: 99, customer: "needle-xyz" });
  await orders.add("big", { blob: "x".repeat(10_000) });
  for (let i = 0; i < 3; i++) await orders.add("later", { n: i }, { delay: 60_000 });
  await orders.add("vip", { n: 1 }, { priority: 5 });

  // --- emails: completed + failed produced by a real worker, with a job log
  const emails = q("emails");
  const worker = new Worker(
    "emails",
    async (job: Job) => {
      if (job.name === "boom") throw new Error(`boom failed ${job.id}`);
      await job.log("hello log");
      await job.updateProgress(100);
      return { sent: true, to: job.data.to };
    },
    { connection, metrics: { maxDataPoints: 60 } },
  );
  workers.push(worker);
  for (let i = 0; i < 3; i++) await emails.add("send", { to: `u${i}@x.io` });
  for (let i = 0; i < 2; i++) await emails.add("boom", { to: `bad${i}@x.io` });
  await waitFor(async () => {
    const c = await emails.getJobCounts("completed", "failed");
    return c.completed === 3 && c.failed === 2;
  });
  await worker.close();

  // --- flow: reports(parent) waits for a child in orders
  const flow = new FlowProducer({ connection });
  await flow.add({
    name: "report",
    queueName: "reports",
    data: { kind: "daily" },
    children: [{ name: "collect", queueName: "orders", data: { part: 1 } }],
  });
  await flow.close();

  // --- fake BullMQ Pro queue written by hand
  const p = "bull:proq:";
  await raw.hset(`${p}meta`, "opts.maxLenEvents", "10000");
  await raw.zadd(`${p}groups`, 1, "g1", 2, "g2");
  for (const id of ["1", "2"]) {
    await raw.hset(`${p}${id}`, {
      name: "grouped",
      data: JSON.stringify({ g: "g1", i: id }),
      opts: JSON.stringify({ group: { id: "g1" } }),
      timestamp: String(Date.now()),
      gid: "g1",
      delay: "0",
      priority: "0",
    });
  }
  await raw.rpush(`${p}groups:g1`, "1", "2");
  await raw.sadd(`${p}groups:paused`, "g2");

  inspector = new RedisInspector({ id: "t", url: URL }, { previewBytes: PREVIEW, discoveryTtlMs: 0 });
});

afterAll(async () => {
  await inspector?.close();
  await Promise.allSettled(workers.map((w) => w.close(true)));
  await Promise.allSettled(queues.map((qq) => qq.close()));
  await raw?.quit();
  try {
    redisCli("shutdown nosave");
  } catch {
    /* already down */
  }
});

describe("keys", () => {
  it("parses queue names from meta keys, incl. hash tags and colons", () => {
    expect(parseQueueNameFromMetaKey("bull", "bull:orders:meta")).toBe("orders");
    expect(parseQueueNameFromMetaKey("bull", "bull:{orders}:meta")).toBe("{orders}");
    expect(parseQueueNameFromMetaKey("bull", "bull:a:b:meta")).toBe("a:b");
    expect(parseQueueNameFromMetaKey("bull", "other:orders:meta")).toBeNull();
    expect(parseQueueNameFromMetaKey("bull", "bull:orders:wait")).toBeNull();
    expect(queueNameFromQueueKey("bull", "bull:reports")).toBe("reports");
  });
  it("globToRegExp handles * and ? and escapes the rest", () => {
    expect(globToRegExp("pay*").test("payments")).toBe(true);
    expect(globToRegExp("pay?").test("pays")).toBe(true);
    expect(globToRegExp("pay?").test("payments")).toBe(false);
    expect(globToRegExp("a.b").test("axb")).toBe(false);
  });
});

describe("connection", () => {
  it("pings and reports server info", async () => {
    const ping = await inspector.ping();
    expect(ping.ok).toBe(true);
    expect(ping.redisVersion).toMatch(/^\d+\.\d+/);
    const info = await inspector.serverInfo();
    expect(info.redisVersion).toBe(ping.redisVersion);
    expect(info.totalKeys).toBeGreaterThan(0);
  });
  it("fails fast on a dead redis", async () => {
    const dead = new RedisInspector({ id: "dead", url: "redis://127.0.0.1:6398" }, { connectTimeoutMs: 500 });
    const ping = await dead.ping();
    expect(ping.ok).toBe(false);
    expect(ping.error).toBeTruthy();
    await dead.close();
  });
});

describe("discovery", () => {
  it("finds every queue through SCAN on meta keys", async () => {
    const names = await inspector.discoverQueues({ force: true });
    expect(names).toEqual(["emails", "orders", "proq", "reports"]);
  });
  it("applies the queueFilter glob", async () => {
    const filtered = new RedisInspector({ id: "f", url: URL, queueFilter: "ord*" });
    expect(await filtered.discoverQueues()).toEqual(["orders"]);
    await filtered.close();
  });
});

describe("stats", () => {
  it("matches bullmq's own counts for every queue in one pipeline", async () => {
    const names = await inspector.discoverQueues();
    const stats = await inspector.getQueueStats(names, { withMetrics: true });
    for (const name of ["orders", "emails", "reports"]) {
      const ref = await q(name).getJobCounts();
      const s = stats[name];
      expect(s.counts.waiting).toBe(ref.waiting);
      expect(s.counts.delayed).toBe(ref.delayed);
      expect(s.counts.prioritized).toBe(ref.prioritized);
      expect(s.counts.completed).toBe(ref.completed);
      expect(s.counts.failed).toBe(ref.failed);
      expect(s.counts["waiting-children"]).toBe(ref["waiting-children"]);
      expect(s.isPaused).toBe(false);
      expect(s.isPro).toBe(false);
      expect(Array.isArray(s.metrics?.completed)).toBe(true);
    }
    expect(stats.orders.counts.waiting).toBe(8); // 5 + needle + big + flow child
    expect(stats.orders.counts.delayed).toBe(3);
    expect(stats.orders.counts.prioritized).toBe(1);
    expect(stats.emails.counts.completed).toBe(3);
    expect(stats.emails.counts.failed).toBe(2);
    expect(stats.reports.counts["waiting-children"]).toBe(1);
    expect(stats.proq.isPro).toBe(true);
    expect(stats.proq.groupsCount).toBe(2);
  });
  it("window counts use zset scores", async () => {
    const w = await inspector.getWindowCounts("emails", 0);
    expect(w).toEqual({ completed: 3, failed: 2 });
    const none = await inspector.getWindowCounts("emails", Date.now() + 60_000);
    expect(none).toEqual({ completed: 0, failed: 0 });
  });
  it("getMetrics returns arrays oldest first", async () => {
    const m = await inspector.getMetrics("emails", 10);
    expect(Array.isArray(m.completed)).toBe(true);
    expect(Array.isArray(m.failed)).toBe(true);
  });
});

describe("getJobs", () => {
  it("pages newest first by default and truncates data in Lua", async () => {
    const page = await inspector.getJobs("orders", "waiting", { start: 0, end: 2, order: "desc" });
    expect(page.total).toBe(8);
    expect(page.jobs).toHaveLength(3);
    const ids = page.jobs.map((j) => Number(j.id));
    expect(ids).toEqual([...ids].sort((a, b) => b - a)); // descending ids = newest first
    const all = await inspector.getJobs("orders", "waiting", { start: 0, end: -1, order: "desc" });
    const big = all.jobs.find((j) => j.name === "big");
    expect(big?.dataTruncated).toBe(true);
    expect(big?.dataPreview.length).toBe(PREVIEW);
    const small = all.jobs.find((j) => j.name === "order");
    expect(small?.dataTruncated).toBe(false);
    expect(JSON.parse(small!.dataPreview)).toHaveProperty("customer");
    expect(small?.state).toBe("waiting");
  });
  it("asc is the exact reverse of desc", async () => {
    const desc = await inspector.getJobs("orders", "waiting", { start: 0, end: -1, order: "desc" });
    const asc = await inspector.getJobs("orders", "waiting", { start: 0, end: -1, order: "asc" });
    expect(asc.jobs.map((j) => j.id)).toEqual(desc.jobs.map((j) => j.id).reverse());
  });
  it("reads zset states with score ordering", async () => {
    const failed = await inspector.getJobs("emails", "failed", { start: 0, end: 10, order: "desc" });
    expect(failed.total).toBe(2);
    expect(failed.jobs[0].failedReason).toMatch(/boom failed/);
    expect(failed.jobs[0].attemptsMade).toBe(1);
    const delayed = await inspector.getJobs("orders", "delayed", { start: 0, end: 10, order: "asc" });
    expect(delayed.total).toBe(3);
    expect(delayed.jobs.every((j) => j.delay === 60_000)).toBe(true);
    const prio = await inspector.getJobs("orders", "prioritized", { start: 0, end: 10, order: "asc" });
    expect(prio.jobs[0].priority).toBe(5);
  });
});

describe("searchJobs", () => {
  it("finds a job by a substring of its data, case-insensitively", async () => {
    const res = await inspector.searchJobs("orders", "waiting", "NEEDLE-xyz", { limit: 10 });
    expect(res.jobs).toHaveLength(1);
    expect(res.jobs[0].name).toBe("order");
    expect(res.nextCursor).toBeNull();
    expect(res.scanned).toBe(8);
    expect(res.total).toBe(8);
  });
  it("hands back a cursor when the batch is smaller than the state", async () => {
    const small = new RedisInspector({ id: "s", url: URL }, { maxScanPerCall: 3 });
    let cursor: string | null = null;
    let scanned = 0;
    const found: string[] = [];
    let calls = 0;
    do {
      const res = await small.searchJobs("orders", "waiting", "needle", { cursor, limit: 10 });
      calls += 1;
      scanned += res.scanned;
      found.push(...res.jobs.map((j) => j.id));
      expect(res.scanned).toBeLessThanOrEqual(3);
      cursor = res.nextCursor;
    } while (cursor !== null);
    expect(found).toHaveLength(1);
    expect(scanned).toBe(8);
    expect(calls).toBe(3);
    await small.close();
  });
  it("stops early at limit and still returns a cursor", async () => {
    const res = await inspector.searchJobs("orders", "waiting", "order", { limit: 2 });
    expect(res.jobs).toHaveLength(2);
    expect(res.nextCursor).not.toBeNull();
  });
  it("searches failedReason too", async () => {
    const res = await inspector.searchJobs("emails", "failed", "boom failed", { limit: 10 });
    expect(res.jobs).toHaveLength(2);
  });
});

describe("getJob", () => {
  it("returns parsed detail for a completed job with logs", async () => {
    const page = await inspector.getJobs("emails", "completed", { start: 0, end: 0, order: "asc" });
    const job = await inspector.getJob("emails", page.jobs[0].id);
    expect(job).not.toBeNull();
    expect(job!.state).toBe("completed");
    expect(job!.data).toEqual({ to: "u0@x.io" });
    expect(job!.returnvalue).toEqual({ sent: true, to: "u0@x.io" });
    expect(job!.opts).toHaveProperty("attempts");
    expect(job!.logs).toEqual(["hello log"]);
    expect(job!.logsCount).toBe(1);
    expect(job!.progress).toBe(100);
    expect(job!.finishedOn).toBeGreaterThan(0);
    expect(job!.dependencies).toBeNull();
    const logs = await inspector.getJobLogs("emails", page.jobs[0].id, { start: 0, end: -1 });
    expect(logs).toEqual({ logs: ["hello log"], count: 1 });
  });
  it("returns stacktrace + reason for a failed job", async () => {
    const page = await inspector.getJobs("emails", "failed", { start: 0, end: 0, order: "asc" });
    const job = await inspector.getJob("emails", page.jobs[0].id);
    expect(job!.state).toBe("failed");
    expect(job!.failedReason).toMatch(/boom failed/);
    expect(job!.stacktrace.length).toBeGreaterThan(0);
    expect(job!.stacktrace[0]).toContain("boom failed");
  });
  it("detects list states with LPOS and resolves flow parents", async () => {
    const waiting = await inspector.getJobs("orders", "waiting", { start: 0, end: -1, order: "desc" });
    const child = waiting.jobs.find((j) => j.name === "collect")!;
    expect(child.parent).toEqual({ id: expect.any(String), queueKey: "bull:reports", queue: "reports" });
    const detail = await inspector.getJob("orders", child.id);
    expect(detail!.state).toBe("waiting");
    expect(detail!.parent?.queue).toBe("reports");

    const parent = await inspector.getJob("reports", child.parent!.id);
    expect(parent!.state).toBe("waiting-children");
    expect(parent!.dependencies).toEqual({ processed: 0, unprocessed: 1 });

    const delayed = await inspector.getJobs("orders", "delayed", { start: 0, end: 0, order: "asc" });
    expect((await inspector.getJob("orders", delayed.jobs[0].id))!.state).toBe("delayed");
  });
  it("returns null for unknown ids", async () => {
    expect(await inspector.getJob("orders", "nope")).toBeNull();
  });
});

describe("flows", () => {
  it("samples parent queue keys", async () => {
    const { edges, sampled } = await inspector.sampleFlowEdges("orders", { sample: 20 });
    expect(sampled).toBeGreaterThan(0);
    expect(edges).toEqual([{ parentQueue: "reports", childQueue: "orders", count: 1 }]);
    const none = await inspector.sampleFlowEdges("emails");
    expect(none.edges).toEqual([]);
  });
});

describe("BullMQ Pro groups (hand-written keys)", () => {
  it("lists groups with status and waiting counts", async () => {
    const { groups, total } = await inspector.getGroups("proq", { start: 0, end: 10 });
    expect(total).toBe(2);
    expect(groups).toEqual([
      { id: "g1", score: 1, waiting: 2, status: "waiting" },
      { id: "g2", score: 2, waiting: 0, status: "paused" },
    ]);
  });
  it("pages a group's jobs and exposes the group id", async () => {
    const page = await inspector.getGroupJobs("proq", "g1", { start: 0, end: 10 });
    expect(page.total).toBe(2);
    expect(page.jobs.map((j) => j.groupId)).toEqual(["g1", "g1"]);
    expect(page.jobs[0].name).toBe("grouped");
  });
});

describe("writes (official bullmq API)", () => {
  it("retries a failed job", async () => {
    const failed = await inspector.getJobs("emails", "failed", { start: 0, end: 0, order: "asc" });
    const id = failed.jobs[0].id;
    await inspector.retryJob("emails", id);
    expect((await inspector.getJob("emails", id))!.state).toBe("waiting");
    await expect(inspector.retryJob("emails", id)).rejects.toThrow(/cannot_retry_job_in_state_waiting/);
  });
  it("retryAll moves every failed job back to waiting", async () => {
    await inspector.retryAll("emails", "failed");
    const s = await inspector.getQueueStats(["emails"]);
    expect(s.emails.counts.failed).toBe(0);
    expect(s.emails.counts.waiting).toBe(2);
  });
  it("promotes a delayed job", async () => {
    const delayed = await inspector.getJobs("orders", "delayed", { start: 0, end: 0, order: "asc" });
    const id = delayed.jobs[0].id;
    await inspector.promoteJob("orders", id);
    expect((await inspector.getJob("orders", id))!.state).toBe("waiting");
    const s = await inspector.getQueueStats(["orders"]);
    expect(s.orders.counts.delayed).toBe(2);
  });
  it("removes a job", async () => {
    const delayed = await inspector.getJobs("orders", "delayed", { start: 0, end: 0, order: "asc" });
    const id = delayed.jobs[0].id;
    await inspector.removeJob("orders", id);
    expect(await inspector.getJob("orders", id)).toBeNull();
    await expect(inspector.removeJob("orders", id)).rejects.toThrow(/job_not_found/);
  });
  it("adds a job", async () => {
    const { id } = await inspector.addJob("orders", "manual", { from: "ui" }, { attempts: 2 });
    const job = await inspector.getJob("orders", id);
    expect(job!.name).toBe("manual");
    expect(job!.data).toEqual({ from: "ui" });
    expect(job!.attempts).toBe(2);
    expect(job!.state).toBe("waiting");
  });
  it("pauses and resumes", async () => {
    await inspector.pauseQueue("orders");
    expect((await inspector.getQueueStats(["orders"])).orders.isPaused).toBe(true);
    await inspector.resumeQueue("orders");
    expect((await inspector.getQueueStats(["orders"])).orders.isPaused).toBe(false);
  });
  it("cleans completed jobs", async () => {
    const before = (await inspector.getQueueStats(["emails"])).emails.counts.completed;
    expect(before).toBe(3);
    const { removed } = await inspector.cleanQueue("emails", "completed", 0, 1000);
    expect(removed).toBe(3);
    expect((await inspector.getQueueStats(["emails"])).emails.counts.completed).toBe(0);
  });
  it("discards an active job without the worker lock", async () => {
    const stuck = q("stuck");
    let release: () => void = () => undefined;
    const worker = new Worker(
      "stuck",
      () => new Promise<void>((resolve) => {
        release = resolve;
      }),
      { connection },
    );
    workers.push(worker);
    const active = new Promise<void>((resolve) => worker.once("active", () => resolve()));
    const job = await stuck.add("hang", {}, { attempts: 3 });
    await active;
    await inspector.discardJob("stuck", job.id!);
    const detail = await inspector.getJob("stuck", job.id!);
    expect(detail!.state).toBe("failed");
    expect(detail!.failedReason).toBe("Discarded from BullMQ Visualizer");
    await expect(inspector.discardJob("stuck", job.id!)).rejects.toThrow(/cannot_discard_job_in_state_failed/);
    release();
    await worker.close(true);
  });
  it("drains and obliterates", async () => {
    await inspector.drainQueue("orders", true);
    const s = await inspector.getQueueStats(["orders"]);
    expect(s.orders.counts.waiting).toBe(0);
    expect(s.orders.counts.delayed).toBe(0);
    await inspector.obliterateQueue("emails");
    const names = await inspector.discoverQueues({ force: true });
    expect(names).not.toContain("emails");
  });
});

describe("pool", () => {
  it("reuses an inspector per id and rebuilds when the target changes", async () => {
    const pool = new RedisInspectorPool({ connectTimeoutMs: 500 });
    const a = pool.get({ id: "c1", url: URL });
    const b = pool.get({ id: "c1", url: URL, prefix: "bull" });
    expect(b).toBe(a);
    const c = pool.get({ id: "c1", url: URL, prefix: "other" });
    expect(c).not.toBe(a);
    expect(c.config.prefix).toBe("other");
    expect(pool.ids()).toEqual(["c1"]);
    await pool.evict("c1");
    expect(pool.ids()).toEqual([]);
    await pool.closeAll();
  });
});

describe("rates + setup (round 2)", () => {
  it("reports success/failure over the trailing window from ZCOUNT", async () => {
    // own queue: earlier tests retry/clean `emails`, so its finished sets are not stable
    const ratesq = q("ratesq");
    const w = new Worker(
      "ratesq",
      async (job: Job) => {
        if (job.name === "boom") throw new Error("boom");
        return 1;
      },
      { connection },
    );
    workers.push(w);
    for (let i = 0; i < 3; i++) await ratesq.add("ok", { i });
    for (let i = 0; i < 2; i++) await ratesq.add("boom", { i });
    await waitFor(async () => {
      const c = await ratesq.getJobCounts("completed", "failed");
      return c.completed === 3 && c.failed === 2;
    });
    await w.close();

    const s = (await inspector.getQueueStats(["ratesq"])).ratesq;
    expect(s.rates).toEqual({ windowMinutes: 60, completed: 3, failed: 2, successPct: 60 });
    expect(s.library).toMatch(/^bullmq:/);

    // a window that starts in the future sees nothing -> no rate
    const idle = (await inspector.getQueueStats(["ratesq"], { rateWindowMinutes: -1 })).ratesq;
    expect(idle.rates).toEqual({ windowMinutes: -1, completed: 0, failed: 0, successPct: null });
  });

  it("reads the queue setup from meta + limiter + workers", async () => {
    const orders = q("orders");
    await orders.setGlobalConcurrency(7);
    await orders.setGlobalRateLimit(100, 5_000);
    const setup = await inspector.getQueueSetup("orders");
    expect(setup.library).toMatch(/^bullmq:/);
    expect(setup.isPro).toBe(false);
    expect(setup.globalConcurrency).toBe(7);
    expect(setup.globalRateLimit).toEqual({ max: 100, durationMs: 5_000 });
    expect(setup.batch).toBe("unknown");
    expect(setup.rateLimitedNow).toBeNull();
    expect(setup.workers).not.toBeNull();
    expect(setup.groups).toBeNull();
    expect(typeof setup.maxLenEvents === "number" || setup.maxLenEvents === null).toBe(true);
    await orders.removeGlobalConcurrency();
    await orders.removeGlobalRateLimit();
  });

  it("counts connected workers via CLIENT LIST and sees an active limiter", async () => {
    const w = new Worker("orders", async () => undefined, {
      connection,
      name: "e2e-worker",
      autorun: false,
      limiter: { max: 1, duration: 60_000 },
    });
    await w.waitUntilReady();
    // bypass the 10 s cache by inspecting through a fresh inspector
    const fresh = new RedisInspector({ id: "fresh", url: URL });
    try {
      const setup = await fresh.getQueueSetup("orders");
      expect(setup.workers?.count).toBeGreaterThanOrEqual(1);
      expect(setup.workers?.names).toContain("e2e-worker");
    } finally {
      await fresh.close();
      await w.close();
    }
    // simulate a limiter in effect: bullmq stores it as a key with a TTL
    await raw.set("bull:orders:limiter", "1", "PX", 30_000);
    const fresh2 = new RedisInspector({ id: "fresh2", url: URL });
    try {
      const setup = await fresh2.getQueueSetup("orders");
      expect(setup.rateLimitedNow?.ttlMs).toBeGreaterThan(0);
    } finally {
      await fresh2.close();
      await raw.del("bull:orders:limiter");
    }
  });

  it("flags Pro queues from the groups zset and exposes group settings", async () => {
    const setup = await inspector.getQueueSetup("proq");
    expect(setup.isPro).toBe(true);
    expect(setup.groups?.count).toBe(2);
    expect(typeof setup.groups?.concurrencyLimited).toBe("boolean");
  });
});
