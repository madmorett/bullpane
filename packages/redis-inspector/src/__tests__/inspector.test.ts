/**
 * Integration test against a REAL redis-server on port 6399 (never the dev one on 6379).
 * Data is produced with the official bullmq API so the key layout is exactly what
 * customers have. Pro group keys are written by hand (no Pro token here) in the
 * layout keys.ts documents, verified against @taskforcesh/bullmq-pro 7.48.0.
 */
import { execSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Redis from "ioredis";
import { FlowProducer, Queue, Worker, type Job } from "bullmq";
import { JOB_STATES } from "@bullpane/shared";
import {
  RedisInspector,
  RedisInspectorPool,
  dropGroupMetaNames,
  globToRegExp,
  parseQueueNameFromMetaKey,
  queueNameFromQueueKey,
} from "../index.js";

const PORT = 6399;
const URL = `redis://127.0.0.1:${PORT}`;
const connection = { host: "127.0.0.1", port: PORT };
const PREVIEW = 200;
/** fixed scores of the fake Pro status zsets, asserted back verbatim */
const MAXED_AT = 1_700_000_000_000;
const PAUSED_AT = MAXED_AT + 1;
const LIMIT_UNTIL = Date.now() + 60_000;

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

  // --- fake BullMQ Pro queue written by hand, one group per status
  const p = "bull:proq:";
  await raw.hset(`${p}meta`, "opts.maxLenEvents", "10000");
  const grouped = (id: string, gid: string, extra: Record<string, string> = {}) =>
    raw.hset(`${p}${id}`, {
      name: "grouped",
      data: JSON.stringify({ g: gid, i: id }),
      opts: JSON.stringify({ group: { id: gid } }),
      timestamp: String(Date.now()),
      gid,
      delay: "0",
      priority: "0",
      ...extra,
    });
  // g1 waiting: two list jobs (LPUSH => list reads [2, 1]) and one prioritized
  await grouped("1", "g1");
  await grouped("2", "g1");
  await grouped("3", "g1", { priority: "1" });
  await raw.zadd(`${p}groups`, 1, "g1");
  await raw.lpush(`${p}groups:g1`, "1", "2");
  await raw.zadd(`${p}groups:g1:p`, 1, "3");
  // g4 limited: 5 / 10 s override, counter pinned past 999999, lifts at LIMIT_UNTIL
  await grouped("40", "g4");
  await raw.lpush(`${p}groups:g4`, "40");
  await raw.zadd(`${p}groups:limit`, LIMIT_UNTIL, "g4");
  await raw.set(`${p}groups:g4:limit`, "1000001", "PX", 60_000);
  await raw.hset(`${p}groups:g4:meta`, { lm: "5", ld: "10000" });
  // g3 maxed: concurrency 2, both slots busy
  await grouped("30", "g3");
  await raw.lpush(`${p}groups:g3`, "30");
  await raw.zadd(`${p}groups:max`, MAXED_AT, "g3");
  await raw.hset(`${p}groups:g3:meta`, "conc", "2");
  await raw.hset(`${p}groups:active:count`, "g3", "2");
  // g2 paused
  await raw.zadd(`${p}groups:paused`, PAUSED_AT, "g2");
  await raw.zadd(`${p}groups:metas`, 1, "g3", 2, "g4");
  // a second Pro queue whose only group is maxed: it has NO `groups` key at all
  await raw.hset("bull:proq2:meta", "version", "bullmq-pro:7.48.0");
  await raw.zadd("bull:proq2:groups:max", MAXED_AT, "only");

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
    expect(names).toEqual(["emails", "orders", "proq", "proq2", "reports"]);
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
    expect(stats.proq.groupsCount).toBe(4);
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
    expect(big?.dataBytes).toBeGreaterThan(10_000);
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

describe("BullMQ Pro groups (hand-written keys, bullmq-pro 7.48 layout)", () => {
  it("lists every status zset in Pro's order with per-group settings", async () => {
    const page = await inspector.getGroups("proq", { start: 0, end: 10 });
    expect(page.total).toBe(4);
    expect(page.byStatus).toEqual({ waiting: 1, limited: 1, maxed: 1, paused: 1 });
    expect(page.groups).toEqual([
      { id: "g1", status: "waiting", waiting: 3, prioritized: 1, active: 0, concurrency: null, rateLimit: null, limitedUntil: null, since: null },
      { id: "g4", status: "limited", waiting: 1, prioritized: 0, active: 0, concurrency: null, rateLimit: { max: 5, durationMs: 10_000 }, limitedUntil: LIMIT_UNTIL, since: null },
      { id: "g3", status: "maxed", waiting: 1, prioritized: 0, active: 2, concurrency: 2, rateLimit: null, limitedUntil: null, since: MAXED_AT },
      { id: "g2", status: "paused", waiting: 0, prioritized: 0, active: 0, concurrency: null, rateLimit: null, limitedUntil: null, since: PAUSED_AT },
    ]);
  });
  it("pages across the four status zsets as one list", async () => {
    const mid = await inspector.getGroups("proq", { start: 1, end: 2 });
    expect(mid.total).toBe(4);
    expect(mid.groups.map((g) => g.id)).toEqual(["g4", "g3"]);
    const last = await inspector.getGroups("proq", { start: 3, end: 3 });
    expect(last.groups.map((g) => g.id)).toEqual(["g2"]);
    const past = await inspector.getGroups("proq", { start: 4, end: 9 });
    expect(past.groups).toEqual([]);
  });
  it("pages a group's jobs: its list first, then its prioritized zset", async () => {
    const page = await inspector.getGroupJobs("proq", "g1", { start: 0, end: 10 });
    expect(page.total).toBe(3);
    expect(page.jobs.map((j) => j.id)).toEqual(["2", "1", "3"]);
    expect(page.jobs.map((j) => j.groupId)).toEqual(["g1", "g1", "g1"]);
    expect(page.jobs[0].name).toBe("grouped");
    const tail = await inspector.getGroupJobs("proq", "g1", { start: 2, end: 2 });
    expect(tail.total).toBe(3);
    expect(tail.jobs.map((j) => j.id)).toEqual(["3"]);
  });
  it("does not mistake `groups:${gid}:meta` hashes for queues", async () => {
    const names = await inspector.discoverQueues();
    expect(names).toContain("proq");
    expect(names).toContain("proq2");
    expect(names.filter((n) => n.includes(":groups:"))).toEqual([]);
    expect(dropGroupMetaNames(["orders", "orders:groups:t1", "a:groups:b"]).sort()).toEqual(["a:groups:b", "orders"]);
  });
  it("flags a Pro queue whose groups are all maxed (no `groups` key)", async () => {
    const stats = await inspector.getQueueStats(["proq2"]);
    expect(stats.proq2.isPro).toBe(true);
    expect(stats.proq2.groupsCount).toBe(1);
    expect(stats.proq2.library).toBe("bullmq-pro:7.48.0");
  });
});

describe("payload size caps (a page or a search never moves megabytes through Lua)", () => {
  it("does not read `data` above listFieldCapBytes but still reports its size", async () => {
    const capped = new RedisInspector({ id: "cap", url: URL }, { previewBytes: PREVIEW, listFieldCapBytes: 5_000 });
    const all = await capped.getJobs("orders", "waiting", { start: 0, end: -1, order: "desc" });
    const big = all.jobs.find((j) => j.name === "big");
    expect(big?.dataPreview).toBe("");
    expect(big?.dataTruncated).toBe(true);
    expect(big?.dataBytes).toBeGreaterThan(10_000);
    const small = all.jobs.find((j) => j.name === "order");
    expect(small?.dataPreview).not.toBe("");
    expect(small?.dataBytes).toBe(Buffer.byteLength(small!.dataPreview));
    await capped.close();
  });
  it("search skips `data` above searchFieldCapBytes and says how many it skipped", async () => {
    const capped = new RedisInspector({ id: "scap", url: URL }, { previewBytes: PREVIEW, searchFieldCapBytes: 5_000 });
    const res = await capped.searchJobs("orders", "waiting", "blob", { limit: 10 });
    expect(res.jobs).toHaveLength(0); // "blob" only occurs inside the 10 KB payload
    expect(res.skippedLargePayloads).toBe(1);
    const open = await inspector.searchJobs("orders", "waiting", "blob", { limit: 10 });
    expect(open.jobs.map((j) => j.name)).toEqual(["big"]);
    expect(open.skippedLargePayloads).toBe(0);
    await capped.close();
  });
  it("search hands back a cursor once searchByteBudget is spent", async () => {
    const tight = new RedisInspector({ id: "budget", url: URL }, { previewBytes: PREVIEW, searchByteBudget: 1 });
    const res = await tight.searchJobs("orders", "waiting", "zz-not-there", { limit: 10 });
    expect(res.scanned).toBe(1);
    expect(res.nextCursor).toBe("1");
    await tight.close();
  });
});

describe("discovery on a huge keyspace", () => {
  it("lists queues with a connected worker even when the SCAN budget finds nothing", async () => {
    const dq = q("discover-me");
    await dq.waitUntilReady();
    const w = new Worker("discover-me", async () => undefined, { connection });
    workers.push(w);
    await w.waitUntilReady();
    // maxScanIterations 0: the SCAN never runs, so only CLIENT LIST can find it.
    const blind = new RedisInspector({ id: "blind", url: URL }, { maxScanIterations: 0, discoveryTtlMs: 0 });
    await waitFor(async () => (await blind.discoverQueues({ force: true })).includes("discover-me"));
    const status = await blind.discoveryStatus();
    expect(status.complete).toBe(false);
    expect(status.totalKeys).toBeGreaterThan(0);
    await blind.close();
    await w.close();
  });
  it("reports a complete cycle once the SCAN wrapped around", async () => {
    await inspector.discoverQueues({ force: true });
    expect((await inspector.discoveryStatus()).complete).toBe(true);
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
    expect(detail!.failedReason).toBe("Discarded from Bullpane");
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
    expect(s.rates).toEqual({ windowMinutes: 60, completed: 3, failed: 2, successPct: 60, source: "zset", retentionSkewed: false });
    expect(s.library).toMatch(/^bullmq:/);

    // a window that starts in the future sees nothing -> no rate
    const idle = (await inspector.getQueueStats(["ratesq"], { rateWindowMinutes: -1 })).ratesq;
    expect(idle.rates).toEqual({ windowMinutes: -1, completed: 0, failed: 0, successPct: null, source: "zset", retentionSkewed: false });
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

  it("flags Pro queues from the group keys and exposes group settings", async () => {
    const setup = await inspector.getQueueSetup("proq");
    expect(setup.isPro).toBe(true);
    expect(setup.groups).toEqual({ count: 4, byStatus: { waiting: 1, limited: 1, maxed: 1, paused: 1 }, configured: 2, active: 1 });
  });
});

describe("success rate vs retention (removeOnComplete)", () => {
  /**
   * The reported bug: with `removeOnComplete: { count: 50 }` the zsets only keep
   * 50 completed jobs while the failed ones stay. The ratio becomes 50/(50+N) and
   * shows a terrible number for a healthy queue. BullMQ's metrics are cumulative
   * counters and do not suffer from this.
   */
  it("uses BullMQ's metrics and ignores the zset pruning", async () => {
    const fila = q("retencao-com-metrics");
    const w = new Worker(
      "retencao-com-metrics",
      async (job: Job) => {
        if (job.name === "bad") throw new Error("failed");
        return 1;
      },
      { connection, metrics: { maxDataPoints: 100 } },
    );
    workers.push(w);

    for (let i = 0; i < 200; i++) await fila.add("ok", { i }, { removeOnComplete: { count: 50 }, attempts: 1 });
    for (let i = 0; i < 20; i++) await fila.add("bad", { i }, { removeOnComplete: { count: 50 }, attempts: 1 });
    await waitFor(async () => {
      const c = await fila.getJobCounts("completed", "failed");
      return c.failed === 20 && c.completed === 50; // pruning already happened
    });
    await w.close();

    const s = (await inspector.getQueueStats(["retencao-com-metrics"]))["retencao-com-metrics"];
    // the zsets would say 50/(50+20) = 71.4%; the real number is 200/(200+20) = 90.9%
    expect(s.rates.source).toBe("metrics");
    expect(s.rates.completed).toBe(200);
    expect(s.rates.failed).toBe(20);
    expect(s.rates.successPct).toBeCloseTo(90.9, 0);
    expect(s.rates.retentionSkewed).toBe(false);
  });

  it("flags retentionSkewed when there are no metrics and the queue prunes completed jobs", async () => {
    const fila = q("retencao-sem-metrics");
    const w = new Worker(
      "retencao-sem-metrics",
      async (job: Job) => {
        if (job.name === "bad") throw new Error("failed");
        return 1;
      },
      { connection },
    );
    workers.push(w);

    for (let i = 0; i < 60; i++) await fila.add("ok", { i }, { removeOnComplete: { count: 10 }, attempts: 1 });
    for (let i = 0; i < 5; i++) await fila.add("bad", { i }, { removeOnComplete: { count: 10 }, attempts: 1 });
    await waitFor(async () => {
      const c = await fila.getJobCounts("completed", "failed");
      return c.failed === 5 && c.completed === 10;
    });
    await w.close();

    const s = (await inspector.getQueueStats(["retencao-sem-metrics"]))["retencao-sem-metrics"];
    expect(s.rates.source).toBe("zset");
    // the ratio is wrong (10/15 = 66.7% instead of 92.3%), which is why it is flagged
    expect(s.rates.retentionSkewed).toBe(true);
  });

  it("does not flag skew when the queue keeps everything", async () => {
    const fila = q("retencao-guarda-tudo");
    const w = new Worker(
      "retencao-guarda-tudo",
      async (job: Job) => {
        if (job.name === "bad") throw new Error("failed");
        return 1;
      },
      { connection },
    );
    workers.push(w);
    for (let i = 0; i < 8; i++) await fila.add("ok", { i }, { attempts: 1 });
    for (let i = 0; i < 2; i++) await fila.add("bad", { i }, { attempts: 1 });
    await waitFor(async () => {
      const c = await fila.getJobCounts("completed", "failed");
      return c.completed === 8 && c.failed === 2;
    });
    await w.close();

    const s = (await inspector.getQueueStats(["retencao-guarda-tudo"]))["retencao-guarda-tudo"];
    expect(s.rates.source).toBe("zset");
    expect(s.rates.retentionSkewed).toBe(false);
    expect(s.rates.successPct).toBe(80);
  });
});

/**
 * `getMetricsCounters` is the ONLY source error alerts use. It reads BullMQ's
 * cumulative counters (`metrics:completed`/`metrics:failed`, field `count`), which
 * are incremented as each job finishes and never decremented — so
 * `removeOnComplete` cannot touch them. The tests below run against a real Redis
 * with the official Worker, so the key layout is exactly the customer's.
 */
describe("getMetricsCounters (source of the error alerts)", () => {
  it("returns the cumulative counters of a queue that collects metrics", async () => {
    const NAME = "counters-com-metrics";
    const fila = q(NAME);
    const w = new Worker(
      NAME,
      async (job: Job) => {
        if (job.name === "bad") throw new Error("failed");
        return 1;
      },
      { connection, metrics: { maxDataPoints: 100 } },
    );
    workers.push(w);
    for (let i = 0; i < 12; i++) await fila.add("ok", { i }, { attempts: 1 });
    for (let i = 0; i < 3; i++) await fila.add("bad", { i }, { attempts: 1 });
    await waitFor(async () => {
      const c = await fila.getJobCounts("completed", "failed");
      return c.completed === 12 && c.failed === 3;
    });
    await w.close();

    const before = Date.now();
    const counters = await inspector.getMetricsCounters(NAME);
    expect(counters.completed).toBe(12);
    expect(counters.failed).toBe(3);
    expect(counters.collectedAt).toBeGreaterThanOrEqual(before);
    expect(counters.collectedAt).toBeLessThanOrEqual(Date.now());
  });

  it("returns null (not zero) when the queue does NOT collect metrics", async () => {
    // Without `metrics` on the Worker, BullMQ never creates the hashes. Zero would
    // mean a perfectly healthy queue; null is "I don't know", and the alert stays inert.
    const NAME = "counters-sem-metrics";
    const fila = q(NAME);
    const w = new Worker(
      NAME,
      async (job: Job) => {
        if (job.name === "bad") throw new Error("failed");
        return 1;
      },
      { connection },
    );
    workers.push(w);
    for (let i = 0; i < 5; i++) await fila.add("ok", { i }, { attempts: 1 });
    for (let i = 0; i < 2; i++) await fila.add("bad", { i }, { attempts: 1 });
    await waitFor(async () => {
      const c = await fila.getJobCounts("completed", "failed");
      return c.completed === 5 && c.failed === 2;
    });
    await w.close();

    const counters = await inspector.getMetricsCounters(NAME);
    expect(counters.completed).toBeNull();
    expect(counters.failed).toBeNull();
  });

  it("returns null for a queue that does not exist", async () => {
    const counters = await inspector.getMetricsCounters("queue-that-never-existed");
    expect(counters).toMatchObject({ completed: null, failed: null });
  });

  /**
   * The exact scenario of the bug: with aggressive pruning the zset ZCOUNT lies and
   * the cumulative counter does not. This test compares BOTH sources side by side on
   * the same queue, so it fails if anyone wires the ZCOUNT back into the alerts.
   */
  it("is right where the ZCOUNT would be wrong: aggressive pruning of completed jobs", async () => {
    const NAME = "counters-com-poda";
    const fila = q(NAME);
    const w = new Worker(
      NAME,
      async (job: Job) => {
        if (job.name === "bad") throw new Error("failed");
        return 1;
      },
      { connection, metrics: { maxDataPoints: 100 } },
    );
    workers.push(w);

    // 300 ok / 15 failures = 4.8% failure rate, but only 50 completed jobs survive.
    for (let i = 0; i < 300; i++) await fila.add("ok", { i }, { removeOnComplete: { count: 50 }, attempts: 1 });
    for (let i = 0; i < 15; i++) await fila.add("bad", { i }, { removeOnComplete: { count: 50 }, attempts: 1 });
    await waitFor(async () => {
      const c = await fila.getJobCounts("completed", "failed");
      return c.completed === 50 && c.failed === 15;
    }, 60_000);
    await w.close();

    const counters = await inspector.getMetricsCounters(NAME);
    const zset = await inspector.getWindowCounts(NAME, 0);

    // the truth
    expect(counters.completed).toBe(300);
    expect(counters.failed).toBe(15);
    const realRate = (counters.failed! / (counters.completed! + counters.failed!)) * 100;
    expect(realRate).toBeCloseTo(4.8, 1);

    // what the alert used to see: the healthy queue above firing "rate > 10%"
    expect(zset.completed).toBe(50);
    expect(zset.failed).toBe(15);
    const zsetRate = (zset.failed / (zset.completed + zset.failed)) * 100;
    expect(zsetRate).toBeCloseTo(23.1, 1);
    expect(zsetRate).toBeGreaterThan(10);
    expect(realRate).toBeLessThan(10);
  });

  it("the counter is already valid before the minute rolls over, while the :data list is still empty", async () => {
    // This is why we read the hash and not `metrics:completed:data`: for the first
    // 60 s the list is empty and an alert based on it would measure nothing.
    const NAME = "counters-primeiro-minuto";
    const fila = q(NAME);
    const w = new Worker(NAME, async () => 1, { connection, metrics: { maxDataPoints: 100 } });
    workers.push(w);
    for (let i = 0; i < 4; i++) await fila.add("ok", { i }, { attempts: 1 });
    await waitFor(async () => (await fila.getJobCounts("completed")).completed === 4);
    await w.close();

    const counters = await inspector.getMetricsCounters(NAME);
    expect(counters.completed).toBe(4);
    const dataLen = Number(await raw.llen(`bull:${NAME}:metrics:completed:data`));
    expect(dataLen).toBe(0); // no per-minute point yet, and the counter is already right
  });
});

describe("job schedulers (repeatable jobs)", () => {
  /**
   * Schedulers do not appear in any of the 8 states: bullmq keeps them in the
   * `repeat` zset (id -> next run) plus a `repeat:${id}` hash. These are created
   * with the official `upsertJobScheduler` so the key layout is exactly the real one.
   */
  const NAME = "schedulers";

  it("returns every, pattern, tz, limit, template and the next run", async () => {
    const fila = q(NAME);
    await fila.upsertJobScheduler(
      "every-30s",
      { every: 30_000, limit: 5 },
      { name: "tick", data: { hello: "world" }, opts: { attempts: 3 } },
    );
    await fila.upsertJobScheduler(
      "cron-daily",
      { pattern: "0 3 * * *", tz: "America/Sao_Paulo" },
      { name: "nightly", data: { report: true } },
    );

    const { schedulers, total } = await inspector.getSchedulers(NAME, { start: 0, end: -1 });
    expect(total).toBe(2);

    const every = schedulers.find((s) => s.key === "every-30s");
    expect(every).toBeDefined();
    expect(every!.name).toBe("tick");
    expect(every!.every).toBe(30_000);
    expect(every!.pattern).toBeNull();
    expect(every!.limit).toBe(5);
    expect(every!.iterationCount).toBe(1);
    expect(every!.next).toBeGreaterThan(0);
    expect(every!.template?.data).toContain("world");
    expect(every!.template?.opts).toContain("attempts");

    const cron = schedulers.find((s) => s.key === "cron-daily");
    expect(cron).toBeDefined();
    expect(cron!.name).toBe("nightly");
    expect(cron!.pattern).toBe("0 3 * * *");
    expect(cron!.every).toBeNull();
    expect(cron!.tz).toBe("America/Sao_Paulo");
    expect(cron!.next).toBeGreaterThan(Date.now());
  });

  it("the next run matches the delayed job the scheduler produced", async () => {
    const raw2 = new Redis(URL);
    const delayed = await raw2.zrange(`bull:${NAME}:delayed`, 0, -1);
    await raw2.quit();
    const { schedulers } = await inspector.getSchedulers(NAME, { start: 0, end: -1 });
    const cron = schedulers.find((s) => s.key === "cron-daily")!;
    // bullmq names the produced job `repeat:${key}:${millis}`
    expect(delayed).toContain(`repeat:cron-daily:${cron.next}`);
  });

  it("pages by start/end and orders by next run", async () => {
    const fila = q(NAME);
    await fila.upsertJobScheduler("z-later", { pattern: "0 4 * * *" });

    const all = await inspector.getSchedulers(NAME, { start: 0, end: -1 });
    expect(all.total).toBe(3);
    // ZRANGE by score: the soonest one first
    const nexts = all.schedulers.map((s) => s.next ?? 0);
    expect([...nexts].sort((a, b) => a - b)).toEqual(nexts);

    const first = await inspector.getSchedulers(NAME, { start: 0, end: 0 });
    expect(first.schedulers).toHaveLength(1);
    expect(first.total).toBe(3);
    expect(first.schedulers[0].key).toBe(all.schedulers[0].key);

    const second = await inspector.getSchedulers(NAME, { start: 1, end: 2 });
    expect(second.schedulers.map((s) => s.key)).toEqual(all.schedulers.slice(1).map((s) => s.key));
  });

  it("counts the schedulers in queueStats (a ZCARD, for the tab badge)", async () => {
    const stats = (await inspector.getQueueStats([NAME, "orders"]))!;
    expect(stats[NAME].schedulersCount).toBe(3);
    expect(stats.orders.schedulersCount).toBe(0);
  });

  it("removeScheduler deletes the scheduler and the delayed job it had queued", async () => {
    const before = await inspector.getSchedulers(NAME, { start: 0, end: -1 });
    expect(before.schedulers.some((s) => s.key === "cron-daily")).toBe(true);

    expect(await inspector.removeScheduler(NAME, "cron-daily")).toEqual({ removed: true });

    const after = await inspector.getSchedulers(NAME, { start: 0, end: -1 });
    expect(after.total).toBe(2);
    expect(after.schedulers.some((s) => s.key === "cron-daily")).toBe(false);

    const raw2 = new Redis(URL);
    expect(await raw2.exists(`bull:${NAME}:repeat:cron-daily`)).toBe(0);
    const delayed = await raw2.zrange(`bull:${NAME}:delayed`, 0, -1);
    await raw2.quit();
    expect(delayed.some((id) => id.startsWith("repeat:cron-daily:"))).toBe(false);
  });

  it("removeScheduler on a nonexistent id returns removed: false", async () => {
    expect(await inspector.removeScheduler(NAME, "does-not-exist")).toEqual({ removed: false });
  });

  it("a queue with no schedulers returns an empty list, not an error", async () => {
    expect(await inspector.getSchedulers("orders", { start: 0, end: -1 })).toEqual({ schedulers: [], total: 0 });
  });
});

describe("bulkJobAction (partial result)", () => {
  const NAME = "bulk-target";

  it("retry: applies to the valid ids and returns the reason for the invalid ones, without aborting", async () => {
    const queue = q(NAME);
    const worker = new Worker<unknown, void>(NAME, async () => {
      throw new Error("always fails");
    }, { connection });
    workers.push(worker);
    const ids: string[] = [];
    for (let i = 0; i < 4; i++) ids.push((await queue.add("boom", { i })).id!);
    await waitFor(async () => (await queue.getJobCounts("failed")).failed === 4);
    await worker.close();

    // An id that never existed and one that was already removed: the two real cases
    // of "the operator selected 50 and 3 vanished between the listing and the click".
    await inspector.removeJob(NAME, ids[3]);
    const result = await inspector.bulkJobAction(NAME, "retry", [ids[0], ids[1], "9999", ids[3]]);

    expect(result.action).toBe("retry");
    expect(result.requested).toBe(4);
    expect(result.ok.sort()).toEqual([ids[0], ids[1]].sort());
    expect(result.failed).toHaveLength(2);
    expect(result.failed.map((f) => f.jobId).sort()).toEqual(["9999", ids[3]].sort());
    for (const f of result.failed) expect(f.reason).toMatch(/job_not_found/);
    // And the real effect: the valid ones went back to waiting through BullMQ's scripts.
    for (const id of result.ok) expect((await inspector.getJob(NAME, id))!.state).toBe("waiting");
  });

  it("remove: an id in an incompatible state does not block the others", async () => {
    const queue = q("bulk-remove");
    const a = (await queue.add("one", {})).id!;
    const b = (await queue.add("two", {})).id!;
    const result = await inspector.bulkJobAction("bulk-remove", "remove", [a, b, "inexistente"]);
    expect(result.ok.sort()).toEqual([a, b].sort());
    expect(result.failed).toEqual([{ jobId: "inexistente", reason: "job_not_found" }]);
    expect((await inspector.getQueueStats(["bulk-remove"]))["bulk-remove"].counts.waiting).toBe(0);
  });

  it("promote: only delayed is promotable; the waiting one lands in failed with BullMQ's reason", async () => {
    const queue = q("bulk-promote");
    const delayed = (await queue.add("later", {}, { delay: 60_000 })).id!;
    const waiting = (await queue.add("now", {})).id!;
    const result = await inspector.bulkJobAction("bulk-promote", "promote", [delayed, waiting]);
    expect(result.ok).toEqual([delayed]);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0].jobId).toBe(waiting);
    expect((await inspector.getJob("bulk-promote", delayed))!.state).toBe("waiting");
  });

  it("deduplicates repeated ids instead of spending a round trip to Redis to fail on the second", async () => {
    const queue = q("bulk-dedupe");
    const id = (await queue.add("one", {})).id!;
    const result = await inspector.bulkJobAction("bulk-dedupe", "remove", [id, id, id]);
    expect(result.requested).toBe(1);
    expect(result.ok).toEqual([id]);
    expect(result.failed).toEqual([]);
  });

  it("an empty list is a no-op, not an error", async () => {
    expect(await inspector.bulkJobAction("bulk-dedupe", "retry", [])).toEqual({
      action: "retry",
      ok: [],
      failed: [],
      requested: 0,
    });
  });
});

/**
 * `stalled` is NOT a state (confirmed against bullmq 5.81.4): it is an auxiliary SET
 * `${prefix}:${queue}:stalled` that only exists while something is hung, and
 * `getState()` on a stalled job returns `active`.
 *
 * PATH USED TO STALL FOR REAL (not hand-editing the SET):
 * a Worker with a very short `lockDuration` and `stalledInterval` processes a job
 * that never finishes; we kill the worker with `close(true)` (force), so the lock
 * expires with nobody renewing it. A SECOND worker runs the StalledCheck, finds the
 * job without a lock, puts it in `stalled` and moves it back to `wait` incrementing
 * `stc`. It is exactly the sequence that happens when a pod dies.
 */
describe("stalled (auxiliary SET, not a state)", () => {
  const NAME = "stalling";

  it("stalledCount sees the SET and stalledCounter (`stc`) marks the recovered job", async () => {
    const queue = q(NAME);
    const job = await queue.add("hang", { x: 1 }, { attempts: 1 });

    // Worker 1: takes the job and never finishes. Short lockDuration so the lock
    // expires as soon as it dies; high lockRenewTime so it never renews.
    const dying = new Worker(NAME, () => new Promise<void>(() => undefined), {
      connection,
      lockDuration: 600,
      lockRenewTime: 600_000,
      stalledInterval: 100_000, // its own StalledCheck never runs; the reaper's does
    });
    workers.push(dying);
    await new Promise<void>((resolve) => dying.once("active", () => resolve()));
    // close(true) = force: does not wait for the job to finish and does not release the lock.
    await dying.close(true);
    // Wait for the lock to actually expire: the script only considers a job stalled
    // once its `:lock` key is gone.
    await waitFor(async () => (await raw.exists(`bull:${NAME}:${job.id}:lock`)) === 0, 10_000);

    // Worker 2 (reaper) exists only to run the StalledCheck. We call
    // `moveStalledJobsToWait()` by hand instead of waiting for the timer, because that
    // way the test observes EVERY pass of the script (moveStalledJobsToWait-9.lua):
    //
    //   1. `stalled-check` (SET ... PX) is a throttle: while the key exists, the
    //      script returns immediately. The worker that died already created it at
    //      startup, so the first call here is a no-op.
    //   2. With the key deleted, the pass MARKS the ids from `active` in the `stalled`
    //      SET — and the job stays `active`.
    //   3. The next pass sees the job marked AND without a `:lock`, so it increments
    //      `stc`, moves the job back to `wait` and DELetes the SET.
    //
    // In other words: the SET is transient and exists between two rounds of the check.
    const reaper = new Worker(NAME, async () => "ok", { connection, autorun: false, stalledInterval: 100_000 });
    workers.push(reaper);
    // `moveStalledJobsToWait` is private on the Worker type (it is called by the
    // internal timer). Calling it directly is what makes this test deterministic, so
    // the cast is intentional and contained.
    const check = reaper as unknown as { moveStalledJobsToWait(): Promise<unknown> };
    const runCheck = async () => {
      await raw.del(`bull:${NAME}:stalled-check`);
      await check.moveStalledJobsToWait();
    };

    // The MARKING pass: the job enters the `stalled` SET and queueStats' SCARD sees it.
    await runCheck();
    expect(await raw.smembers(`bull:${NAME}:stalled`)).toEqual([String(job.id)]);
    const marked = await inspector.getQueueStats([NAME]);
    expect(marked[NAME].stalledCount).toBe(1);
    // And the job stays `active` as far as BullMQ is concerned: THIS is the reason
    // there is no "stalled" tab. It is not a state, it is a parallel flag.
    expect((await inspector.getJob(NAME, job.id!))!.state).toBe("active");
    // And it NEVER shows up in counts — the UI shows the number next to active instead.
    expect(marked[NAME].counts.active).toBe(1);

    // The RECOVERING pass: moves it back to `wait` and HINCRBYs `stc`.
    await runCheck();

    // Now the job is back in `wait` and carries `stc = 1`.
    const detail = await inspector.getJob(NAME, job.id!);
    expect(detail!.stalledCounter).toBe(1);
    expect(detail!.state).toBe("waiting");
    const page = await inspector.getJobs(NAME, "waiting", { start: 0, end: -1, order: "desc" });
    expect(page.jobs.find((j) => j.id === job.id)!.stalledCounter).toBe(1);
    // The SET was cleared by the script itself (DEL stalledKey) — it is transient.
    expect((await inspector.getQueueStats([NAME]))[NAME].stalledCount).toBe(0);

    await reaper.close(true);
  }, 30_000);

  it("stalledCount reflects the SET's SCARD (an O(1) SCARD inside queueStats)", async () => {
    const queue = q("stalled-scard");
    await queue.waitUntilReady();
    const key = "bull:stalled-scard:stalled";
    expect((await inspector.getQueueStats(["stalled-scard"]))["stalled-scard"].stalledCount).toBe(0);
    // Writing to the SET directly just to prove the read: the real path is in the
    // test above, with a worker actually killed.
    await raw.sadd(key, "1", "2", "3");
    expect((await inspector.getQueueStats(["stalled-scard"]))["stalled-scard"].stalledCount).toBe(3);
    await raw.del(key);
    expect((await inspector.getQueueStats(["stalled-scard"]))["stalled-scard"].stalledCount).toBe(0);
  });

  it("stalledCounter is 0 on a normal job, and `stalled` is not a JobState", async () => {
    const queue = q("no-stall");
    const id = (await queue.add("fine", {})).id!;
    const page = await inspector.getJobs("no-stall", "waiting", { start: 0, end: -1, order: "desc" });
    expect(page.jobs.find((j) => j.id === id)!.stalledCounter).toBe(0);
    expect(JOB_STATES as readonly string[]).not.toContain("stalled");
  });
});
