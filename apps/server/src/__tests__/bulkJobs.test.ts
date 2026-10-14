/**
 * The bulk action routes, against the real Fastify (`app.inject`), because what
 * matters in them is not the happy path — it is the edges:
 *
 *  - the ids CAP is refused with 400 `validation` before any trip to Redis
 *    (without that someone pastes 100 thousand ids and locks up the customer's Redis);
 *  - the PARTIAL RESULT comes back with 200: one invalid id among valid ones must
 *    not take the others down nor hide which ones failed;
 *  - the minimum role is `operator` (a viewer gets 403);
 *  - the audit `detail` carries COUNTS, never the job payload.
 *
 * The harness is the same as auditHook.test.ts: a fake drizzle-shaped db + fake
 * inspector, no MySQL and no Redis.
 */
import { describe, expect, it, vi } from "vitest";
import { BULK_JOB_LIMIT } from "@bullpane/shared";
import { buildApp } from "../app";
import { loadConfig } from "../config";
import type { Db } from "../db";
import type { AuditLogRow } from "../db/schema";

const CONNECTION = {
  id: "c1",
  name: "prod",
  url: "redis://localhost:6379",
  prefix: "bull",
  cluster: false,
  queueFilter: null,
  createdAt: new Date("2024-01-01T00:00:00.000Z"),
};

const ADMIN = {
  id: "u-admin",
  email: "admin@acme.com",
  name: "Admin",
  role: "admin" as const,
  passwordHash: "x",
  createdAt: new Date("2024-01-01T00:00:00.000Z"),
  lastLoginAt: null, disabledAt: null,
};

function fakeDb() {
  const audit: AuditLogRow[] = [];
  const db = {
    __audit: audit,
    select: () => ({ from: (t: unknown) => chain(tableName(t)) }),
    selectDistinct: () => ({ from: (t: unknown) => chain(tableName(t)) }),
    insert: (t: unknown) => ({
      values(v: AuditLogRow) {
        if (tableName(t) === "audit_log") audit.push(v);
        return Promise.resolve();
      },
      onDuplicateKeyUpdate: () => Promise.resolve(),
    }),
    delete: () => ({ where: () => Promise.resolve() }),
    update: () => ({ set: () => ({ where: () => Promise.resolve() }) }),
  };
  function chain(name: string) {
    const b = {
      where: () => b,
      orderBy: () => b,
      limit: () => b,
      then(resolve: (rows: unknown[]) => unknown) {
        const rows = name === "connections" ? [CONNECTION] : name === "users" ? [ADMIN] : name === "audit_log" ? audit : [];
        return Promise.resolve(rows).then(resolve);
      },
    };
    return b;
  }
  return db as unknown as Db & { __audit: AuditLogRow[] };
}

function tableName(table: unknown): string {
  const sym = Object.getOwnPropertySymbols(table as object).find((s) => String(s).includes("Name"));
  return sym ? String((table as Record<symbol, unknown>)[sym]) : "";
}

/**
 * Fake inspector whose `bulkJobAction` mimics the real one: ids starting with
 * "ghost" fail, the rest go through. The real implementation is tested against a
 * real Redis in packages/redis-inspector; here only the HTTP contract matters.
 */
function fakeInspector() {
  return {
    ping: vi.fn(async () => ({ ok: true, latencyMs: 1, redisVersion: "7.2.0", error: null })),
    discoverQueues: vi.fn(async () => ["payments"]),
    getQueueStats: vi.fn(async () => ({})),
    // "sched-*" ids stand for a job scheduler's delayed job
    promoteJob: vi.fn(async (_queue: string, jobId: string, scheduler = "run_copy") => {
      if (!jobId.startsWith("sched-")) return { mode: "promoted" };
      return scheduler === "skip_next"
        ? { mode: "skipped_next", schedulerId: "nightly" }
        : { mode: "ran_copy", jobId: "copy-1", schedulerId: "nightly" };
    }),
    bullmqProApi: true,
    getDelayedGroups: vi.fn(async () => ({ groups: [{ id: "tenant-a", delayed: 3, nextRunAt: 1, status: null }], ungrouped: 0, scanned: 3, total: 3, nextCursor: null })),
    countMatching: vi.fn(async () => ({ matched: 1234, scanned: 5000, total: 5000, nextCursor: null })),
    promoteMatching: vi.fn(async () => ({
      matched: 3,
      promoted: 2,
      rescheduled: 0,
      unchanged: 0,
      failed: [{ jobId: "9", reason: "job_not_found" }],
      failedCount: 1,
      scanned: 1000,
      total: 5000,
      nextCursor: "998",
    })),
    getGroups: vi.fn(async () => ({ groups: [], total: 0, byStatus: { waiting: 0, limited: 0, maxed: 0, paused: 0 } })),
    pauseGroup: vi.fn(async () => undefined),
    resumeGroup: vi.fn(async () => undefined),
    // "nopro-*" groups stand for an install without BullMQ Pro's package
    drainGroup: vi.fn(async (_queue: string, groupId: string) => {
      if (groupId.startsWith("nopro-")) throw new Error("bullmq_pro_api_required: draining a group needs BullMQ Pro's API");
    }),
    bulkJobAction: vi.fn(async (_queue: string, action: string, jobIds: string[]) => {
      const ok = jobIds.filter((id) => !id.startsWith("ghost"));
      const failed = jobIds.filter((id) => id.startsWith("ghost")).map((jobId) => ({ jobId, reason: "job_not_found" }));
      return { action, ok, failed, requested: jobIds.length };
    }),
  };
}

async function build(role: "admin" | "operator" | "viewer" = "operator") {
  const db = fakeDb();
  const inspector = fakeInspector();
  const pool = { get: () => inspector, evict: vi.fn(async () => undefined), closeAll: vi.fn(async () => undefined) } as never;
  const config = loadConfig({ SESSION_SECRET: "x".repeat(40), DEMO_MODE: "false" }, { warn: () => undefined });
  const app = await buildApp({ config, db, pool, logger: false, serveWeb: false });
  app.addHook("onRequest", async (request) => {
    request.user = { ...ADMIN, role, createdAt: ADMIN.createdAt.toISOString(), lastLoginAt: null, disabledAt: null };
  });
  await app.ready();
  return { app, db, inspector };
}

const url = (action: string) => `/api/connections/c1/queues/payments/jobs/bulk/${action}`;

describe("bulk job actions", () => {
  it("applies the action to every id and reports a partial result with 200", async () => {
    const w = await build();
    const res = await w.app.inject({
      method: "POST",
      url: url("retry"),
      payload: { jobIds: ["1", "2", "ghost-9", "3"] },
    });
    // 200 with partial failures is the central decision: 3 out of 50 that did not
    // go through is information the operator needs, not a reason to drop the 47.
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toEqual(["1", "2", "3"]);
    expect(body.failed).toEqual([{ jobId: "ghost-9", reason: "job_not_found" }]);
    expect(body.requested).toBe(4);
    await w.app.close();
  });

  it("routes each action to the inspector with the right verb", async () => {
    for (const action of ["retry", "remove", "promote"] as const) {
      const w = await build();
      const res = await w.app.inject({ method: "POST", url: url(action), payload: { jobIds: ["1"] } });
      expect(res.statusCode).toBe(200);
      expect(w.inspector.bulkJobAction).toHaveBeenCalledWith("payments", action, ["1"]);
      await w.app.close();
    }
  });

  it("refuses more than BULK_JOB_LIMIT ids with 400, before touching Redis", async () => {
    const w = await build();
    const jobIds = Array.from({ length: BULK_JOB_LIMIT + 1 }, (_, i) => String(i));
    const res = await w.app.inject({ method: "POST", url: url("remove"), payload: { jobIds } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("validation");
    expect(JSON.stringify(res.json())).toContain(String(BULK_JOB_LIMIT));
    // The cap exists for Redis' sake: if the inspector was called, the cap was useless.
    expect(w.inspector.bulkJobAction).not.toHaveBeenCalled();
    await w.app.close();
  });

  it("accepts exactly BULK_JOB_LIMIT ids", async () => {
    const w = await build();
    const jobIds = Array.from({ length: BULK_JOB_LIMIT }, (_, i) => String(i));
    const res = await w.app.inject({ method: "POST", url: url("retry"), payload: { jobIds } });
    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toHaveLength(BULK_JOB_LIMIT);
    await w.app.close();
  });

  it("refuses an empty list", async () => {
    const w = await build();
    const res = await w.app.inject({ method: "POST", url: url("retry"), payload: { jobIds: [] } });
    expect(res.statusCode).toBe(400);
    await w.app.close();
  });

  it("requires the operator role — a viewer gets 403", async () => {
    const w = await build("viewer");
    const res = await w.app.inject({ method: "POST", url: url("remove"), payload: { jobIds: ["1"] } });
    expect(res.statusCode).toBe(403);
    expect(w.inspector.bulkJobAction).not.toHaveBeenCalled();
    await w.app.close();
  });

  it("does not collide with the single-job routes (`bulk` is not a job id)", async () => {
    const w = await build();
    // /jobs/:jobId/retry and /jobs/bulk/retry coexist: the static segment wins
    // over the parameter in Fastify's router. If that precedence flipped, this
    // call would land on the single-job handler with jobId="bulk".
    const res = await w.app.inject({ method: "POST", url: url("retry"), payload: { jobIds: ["1"] } });
    expect(res.statusCode).toBe(200);
    expect(res.json().action).toBe("retry");
    await w.app.close();
  });

  // Not bulk, but the same harness: the single promote carries the scheduler choice.
  describe("single promote of a job scheduler's job", () => {
    const one = (jobId: string) => `/api/connections/c1/queues/payments/jobs/${jobId}/promote`;

    it("runs a copy when no choice is sent, and says so", async () => {
      const w = await build();
      const res = await w.app.inject({ method: "POST", url: one("sched-1") });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true, mode: "ran_copy", jobId: "copy-1", schedulerId: "nightly" });
      expect(w.inspector.promoteJob).toHaveBeenCalledWith("payments", "sched-1", "run_copy");
      await w.app.close();
      expect(w.db.__audit[0]!.detail).toMatchObject({ ranCopy: "copy-1", schedulerId: "nightly" });
    });

    it("passes skip_next through and audits it", async () => {
      const w = await build();
      const res = await w.app.inject({ method: "POST", url: one("sched-1"), payload: { scheduler: "skip_next" } });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true, mode: "skipped_next", schedulerId: "nightly" });
      expect(w.inspector.promoteJob).toHaveBeenCalledWith("payments", "sched-1", "skip_next");
      await w.app.close();
      expect(w.db.__audit[0]!.detail).toMatchObject({ skippedNext: true, schedulerId: "nightly" });
    });

    it("refuses an unknown choice with 400, before touching Redis", async () => {
      const w = await build();
      const res = await w.app.inject({ method: "POST", url: one("sched-1"), payload: { scheduler: "both" } });
      expect(res.statusCode).toBe(400);
      expect(w.inspector.promoteJob).not.toHaveBeenCalled();
      await w.app.close();
    });
  });

  describe("audit", () => {
    it("records counts in detail, never a job payload", async () => {
      const w = await build();
      const res = await w.app.inject({
        method: "POST",
        url: url("retry"),
        payload: { jobIds: ["1", "ghost-2", "3"], data: { cpf: "123.456.789-00" } },
      });
      expect(res.statusCode).toBe(200);
      await w.app.close();

      const row = w.db.__audit[0]!;
      expect(row.action).toBe("job.bulk_retry");
      expect(row.queueName).toBe("payments");
      expect(row.result).toBe("ok");
      expect(row.detail).toMatchObject({ requested: 3, ok: 2, failed: 1 });
      // The privacy assertion: neither the payload that came in the body, nor the
      // job data, may end up in a table the admin exports as CSV.
      const serialised = JSON.stringify(row);
      expect(serialised).not.toContain("123.456.789-00");
      expect(row.detail?.data).toBeUndefined();
      expect(row.detail?.jobIds).toBeUndefined();
    });

    it("uses a distinct action per verb", async () => {
      for (const [action, expected] of [
        ["retry", "job.bulk_retry"],
        ["remove", "job.bulk_remove"],
        ["promote", "job.bulk_promote"],
      ] as const) {
        const w = await build();
        await w.app.inject({ method: "POST", url: url(action), payload: { jobIds: ["1"] } });
        await w.app.close();
        expect(w.db.__audit[0]!.action).toBe(expected);
      }
    });

    it("records a refused call (viewer) as an error", async () => {
      const w = await build("viewer");
      await w.app.inject({ method: "POST", url: url("remove"), payload: { jobIds: ["1"] } });
      await w.app.close();
      const row = w.db.__audit[0]!;
      expect(row.action).toBe("job.bulk_remove");
      expect(row.result).toBe("error");
      expect(row.errorMessage).toContain("forbidden");
    });
  });
});

// Not bulk either, same harness: BullMQ Pro's group operations.
describe("BullMQ Pro group actions", () => {
  it("adds the jobs waiting in groups to the queue summary, saying when the sum stopped at the cap", async () => {
    const w = await build("viewer");
    const stats = (groups: number) => ({
      payments: {
        counts: { waiting: 0, active: 0, completed: 0, failed: 0, delayed: 0, prioritized: 0, paused: 0, "waiting-children": 0 },
        isPaused: false,
        isPro: true,
        groupsCount: 40,
        groupWaiting: { jobs: 36_391, groups },
        rates: { windowMinutes: 60, completed: 0, failed: 0, successPct: null, source: "zset", retentionSkewed: false },
        library: null,
        schedulersCount: 0,
        stalledCount: 0,
      },
    });
    w.inspector.getQueueStats.mockResolvedValueOnce(stats(40) as never).mockResolvedValueOnce(stats(10) as never);
    const full = await w.app.inject({ method: "GET", url: "/api/connections/c1/queues/payments" });
    expect(full.json().groupWaiting).toEqual({ jobs: 36_391, complete: true });
    expect(w.inspector.getQueueStats).toHaveBeenCalledWith(["payments"], expect.objectContaining({ groupWaitingCap: expect.any(Number) }));
    const partial = await w.app.inject({ method: "GET", url: "/api/connections/c1/queues/payments" });
    expect(partial.json().groupWaiting).toEqual({ jobs: 36_391, complete: false });
    await w.app.close();
  });

  const group = (gid: string, action: string) => `/api/connections/c1/queues/payments/groups/${gid}/${action}`;

  it("lists the groups that have delayed jobs, resuming from a cursor", async () => {
    const w = await build("viewer");
    const res = await w.app.inject({ method: "GET", url: "/api/connections/c1/queues/payments/groups-delayed?cursor=7331234567890123:job-42" });
    expect(res.statusCode).toBe(200);
    expect(res.json().groups[0]).toEqual({ id: "tenant-a", delayed: 3, nextRunAt: 1, status: null });
    expect(w.inspector.getDelayedGroups).toHaveBeenCalledWith("payments", { cursor: "7331234567890123:job-42" });
    await w.app.close();
  });

  it("says on the groups list whether BullMQ Pro's API is installed", async () => {
    const w = await build("viewer");
    const res = await w.app.inject({ method: "GET", url: "/api/connections/c1/queues/payments/groups" });
    expect(res.statusCode).toBe(200);
    expect(res.json().bullmqProApi).toBe(true);
    await w.app.close();
  });

  it("pauses and resumes as an operator, audited with the group id", async () => {
    const w = await build("operator");
    expect((await w.app.inject({ method: "POST", url: group("tenant-a", "pause") })).statusCode).toBe(200);
    expect((await w.app.inject({ method: "POST", url: group("tenant-a", "resume") })).statusCode).toBe(200);
    await w.app.close();
    expect(w.inspector.pauseGroup).toHaveBeenCalledWith("payments", "tenant-a");
    expect(w.inspector.resumeGroup).toHaveBeenCalledWith("payments", "tenant-a");
    expect(w.db.__audit.map((r) => r.action)).toEqual(["group.pause", "group.resume"]);
    expect(w.db.__audit[0]!.detail).toMatchObject({ groupId: "tenant-a" });
  });

  it("drains only as an admin, like draining a queue", async () => {
    const op = await build("operator");
    expect((await op.app.inject({ method: "POST", url: group("tenant-a", "drain") })).statusCode).toBe(403);
    expect(op.inspector.drainGroup).not.toHaveBeenCalled();
    await op.app.close();

    const admin = await build("admin");
    expect((await admin.app.inject({ method: "POST", url: group("tenant-a", "drain") })).statusCode).toBe(200);
    await admin.app.close();
    expect(admin.db.__audit[0]!.action).toBe("group.drain");
  });

  it("answers 409 with the reason when BullMQ Pro's API is missing", async () => {
    const w = await build("admin");
    const res = await w.app.inject({ method: "POST", url: group("nopro-a", "drain") });
    expect(res.statusCode).toBe(409);
    expect(res.json().message).toMatch(/bullmq_pro_api_required/);
    await w.app.close();
  });
});

// Same harness: promote every delayed job of a group / matching a search.
describe("promote matching", () => {
  const url = "/api/connections/c1/queues/payments/jobs/promote-matching";

  it("passes the group, query and cursor through and audits counts with the group", async () => {
    const w = await build("operator");
    const res = await w.app.inject({ method: "POST", url, payload: { groupId: "tenant-a", query: "spring", cursor: "1000" } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ promoted: 2, failedCount: 1, nextCursor: "998" });
    expect(w.inspector.promoteMatching).toHaveBeenCalledWith("payments", { query: "spring", groupId: "tenant-a" }, { cursor: "1000", limit: expect.any(Number), spread: undefined });
    await w.app.close();
    const row = w.db.__audit[0]!;
    expect(row.action).toBe("job.promote_matching");
    expect(row.detail).toMatchObject({ groupId: "tenant-a", query: "spring", matched: 3, promoted: 2, failed: 1 });
  });

  it("refuses a call with neither a query nor a group, and a viewer", async () => {
    const w = await build("operator");
    expect((await w.app.inject({ method: "POST", url, payload: { query: "  " } })).statusCode).toBe(400);
    await w.app.close();
    const v = await build("viewer");
    expect((await v.app.inject({ method: "POST", url, payload: { groupId: "tenant-a" } })).statusCode).toBe(403);
    expect(v.inspector.promoteMatching).not.toHaveBeenCalled();
    await v.app.close();
  });
});

describe("promote matching: preview and spread", () => {
  const url = "/api/connections/c1/queues/payments/jobs/promote-matching";

  it("counts the matches for the preview as a viewer, with no audit row", async () => {
    const w = await build("viewer");
    const res = await w.app.inject({ method: "GET", url: "/api/connections/c1/queues/payments/jobs/count-matching?groupId=tenant-a&query=spring" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ matched: 1234, nextCursor: null });
    expect(w.inspector.countMatching).toHaveBeenCalledWith("payments", { query: "spring", groupId: "tenant-a" }, { cursor: null });
    await w.app.close();
    expect(w.db.__audit).toHaveLength(0);
  });

  it("passes a spread window through and audits it", async () => {
    const w = await build("operator");
    const spread = { from: 1_000_000, until: 1_000_000 + 3_600_000, total: 1234, offset: 0 };
    const res = await w.app.inject({ method: "POST", url, payload: { groupId: "tenant-a", spread } });
    expect(res.statusCode).toBe(200);
    expect(w.inspector.promoteMatching).toHaveBeenCalledWith("payments", { query: undefined, groupId: "tenant-a" }, { cursor: null, limit: expect.any(Number), spread });
    await w.app.close();
    expect(w.db.__audit[0]!.detail).toMatchObject({ groupId: "tenant-a", spreadFrom: spread.from, spreadUntil: spread.until });
  });

  it("refuses a window that ends before it starts or is longer than 7 days", async () => {
    const w = await build("operator");
    const bad = [
      { from: 2_000, until: 1_000, total: 1, offset: 0 },
      { from: 0, until: 8 * 24 * 3_600_000, total: 1, offset: 0 },
    ];
    for (const spread of bad) expect((await w.app.inject({ method: "POST", url, payload: { groupId: "tenant-a", spread } })).statusCode).toBe(400);
    expect(w.inspector.promoteMatching).not.toHaveBeenCalled();
    await w.app.close();
  });
});

