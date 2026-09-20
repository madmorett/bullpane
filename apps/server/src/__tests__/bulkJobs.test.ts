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
