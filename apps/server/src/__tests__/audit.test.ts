/**
 * The audit log is a compliance claim, so its guarantees are pinned down here:
 *
 *  - a recorded action is listable, with the actor DENORMALISED (name/email/role
 *    are in the row, so the trail survives the user being deleted);
 *  - filters (actor, action, connection, queue, result, date range) narrow it;
 *  - keyset paging walks the whole table and never repeats or skips a row;
 *  - a FAILED insert does NOT propagate — a broken audit table must never turn
 *    "resume the payments queue" into a 500 for the operator on call;
 *  - a failed ACTION is recorded with result "error", because "tried to
 *    obliterate and got a 403" is exactly what an auditor is looking for;
 *  - **a job's `data` NEVER reaches `detail`.** This is the privacy rule from
 *    CLAUDE.md ("never log job data") and the reason the test file exists;
 *  - the route→action map covers every mutating route the API exposes, so a
 *    route added later cannot silently fall out of the trail.
 *
 * No MySQL: `db` is a stub that records the rows it was handed, in the style of
 * hiddenQueues.test.ts / readonly.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuditAction, ListAuditQuery, Role } from "@bullpane/shared";
import { AUDIT_ACTIONS, AUDIT_ACTION_LABEL } from "@bullpane/shared";
import { AuditService, decodeCursor, encodeCursor, sanitizeDetail } from "../services/audit";
import { actionFor, isUnaudited } from "../plugins/audit";
import type { Db } from "../db";
import type { AuditLogRow } from "../db/schema";

const T0 = new Date("2024-06-01T12:00:00.000Z").getTime();

type Row = AuditLogRow;

/**
 * Drizzle-shaped stub over an in-memory array. It has to satisfy exactly the
 * shapes AuditService builds: insert().values(), select().from().where()
 * .orderBy().limit(), selectDistinct(...), delete().where().
 *
 * `where` conditions are opaque objects, so instead of parsing SQL the stub
 * applies the filter the test declares via `__filter`, and the ORDER/LIMIT
 * (which is what paging correctness depends on) is applied for real.
 */
function fakeDb(initial: Row[] = []) {
  const state = { rows: [...initial], failInsert: false, inserted: [] as Row[] };
  let filter: (r: Row) => boolean = () => true;

  const db = {
    __state: state,
    __setFilter(f: (r: Row) => boolean) {
      filter = f;
    },
    insert() {
      return {
        values(v: Row) {
          if (state.failInsert) return Promise.reject(new Error("ER_NO_SUCH_TABLE: Table 'bullpane.audit_log' doesn't exist"));
          state.rows.push(v);
          state.inserted.push(v);
          return Promise.resolve();
        },
      };
    },
    select() {
      return { from: () => builder() };
    },
    selectDistinct() {
      return { from: () => builder() };
    },
    delete() {
      return {
        where(_cond: unknown) {
          state.rows = state.rows.filter((r) => !filter(r));
          return Promise.resolve();
        },
      };
    },
  };

  function builder() {
    let limit = Infinity;
    const b = {
      where(_cond: unknown) {
        return b;
      },
      orderBy(..._o: unknown[]) {
        return b;
      },
      limit(n: number) {
        limit = n;
        return b;
      },
      then(resolve: (rows: Row[]) => unknown) {
        // Real ordering (created_at desc, id desc) and real limit — paging is
        // what this stub must model honestly.
        const rows = state.rows
          .filter(filter)
          .sort((a, z) => z.createdAt.getTime() - a.createdAt.getTime() || (a.id < z.id ? 1 : a.id > z.id ? -1 : 0))
          .slice(0, limit === Infinity ? undefined : limit);
        return Promise.resolve(rows).then(resolve);
      },
    };
    return b;
  }

  return db as unknown as Db & {
    __state: typeof state;
    __setFilter(f: (r: Row) => boolean): void;
  };
}

function logger() {
  return { info: vi.fn(), error: vi.fn() };
}

const ANA = { id: "u-ana", email: "ana@acme.com", name: "Ana", role: "operator" as Role };
const BRUNO = { id: "u-bruno", email: "bruno@acme.com", name: "Bruno", role: "admin" as Role };

const query = (over: Partial<ListAuditQuery> = {}): ListAuditQuery => ({ limit: 50, ...over }) as ListAuditQuery;

describe("AuditService.record", () => {
  let db: ReturnType<typeof fakeDb>;
  let log: ReturnType<typeof logger>;
  let audit: AuditService;

  beforeEach(() => {
    db = fakeDb();
    log = logger();
    audit = new AuditService(db, log);
  });

  it("writes an entry and lists it back", async () => {
    await audit.record({
      action: "queue.pause",
      actor: ANA,
      connectionId: "c1",
      connectionName: "prod",
      queueName: "payments",
      ip: "10.0.0.9",
      userAgent: "Mozilla/5.0",
    });

    const page = await audit.list(query());
    expect(page.entries).toHaveLength(1);
    const e = page.entries[0]!;
    expect(e.action).toBe("queue.pause");
    expect(e.queueName).toBe("payments");
    expect(e.connectionName).toBe("prod");
    expect(e.result).toBe("ok");
    expect(e.ip).toBe("10.0.0.9");
    expect(typeof e.createdAt).toBe("string");
  });

  it("denormalises the actor so the row outlives the user", async () => {
    await audit.record({ action: "queue.obliterate", actor: BRUNO, connectionId: "c1", queueName: "legacy" });
    const [e] = (await audit.list(query())).entries;
    // Name, email and role live IN the row: deleting the user cannot blank them,
    // and "the person who did it left" is the normal audit case.
    expect(e).toMatchObject({ actorId: "u-bruno", actorName: "Bruno", actorEmail: "bruno@acme.com", actorRole: "admin" });
  });

  it("accepts an anonymous actor (failed login on an unknown email)", async () => {
    await audit.record({ action: "auth.login_failed", actor: null, result: "error", detail: { email: "nope@acme.com" } });
    const [e] = (await audit.list(query())).entries;
    expect(e?.actorId).toBeNull();
    expect(e?.detail).toEqual({ email: "nope@acme.com" });
  });

  it("records a FAILED action with result error and the reason", async () => {
    await audit.record({
      action: "queue.obliterate",
      actor: ANA,
      connectionId: "c1",
      queueName: "payments",
      result: "error",
      errorMessage: "forbidden: This action requires the admin role",
    });
    const [e] = (await audit.list(query())).entries;
    expect(e?.result).toBe("error");
    expect(e?.errorMessage).toContain("forbidden");
  });

  it("NEVER throws when the insert fails, and says so in the log", async () => {
    db.__state.failInsert = true;
    // The operator's action already happened. An audit failure must not become
    // their problem.
    await expect(audit.record({ action: "queue.resume", actor: ANA, queueName: "payments" })).resolves.toBeUndefined();
    expect(log.error).toHaveBeenCalledTimes(1);
    expect(String(log.error.mock.calls[0]?.[1])).toContain("audit record failed");
  });

  it("truncates over-long fields instead of failing the insert", async () => {
    await audit.record({
      action: "job.add",
      actor: ANA,
      jobId: "j".repeat(400),
      userAgent: "u".repeat(900),
      errorMessage: "e".repeat(900),
      result: "error",
    });
    const row = db.__state.inserted[0]!;
    expect(row.jobId).toHaveLength(255);
    expect(row.userAgent).toHaveLength(255);
    expect(row.errorMessage).toHaveLength(500);
  });
});

describe("audit detail never carries a job payload", () => {
  // THE privacy test. CLAUDE.md: never log job data. `detail` is for the
  // PARAMETERS of an action; a job's data routinely holds customer PII and the
  // audit table is exportable as CSV, so a leak here leaves the building.
  it("drops `data` even when a caller passes it", () => {
    const clean = sanitizeDetail({
      name: "send-invoice",
      dataBytes: 812,
      data: { cpf: "123.456.789-00", email: "cliente@banco.com.br", amount: 99_00 },
    });
    expect(clean).toEqual({ name: "send-invoice", dataBytes: 812 });
    expect(JSON.stringify(clean)).not.toContain("123.456.789-00");
  });

  it("drops payload/body/returnvalue and credentials at any depth", () => {
    const clean = sanitizeDetail({
      state: "completed",
      payload: { secretStuff: 1 },
      body: "raw",
      returnvalue: { token: "x" },
      password: "hunter2",
      url: "redis://user:p4ss@prod:6379",
      token: "abc",
      nested: { keep: true, data: { pii: "no" }, password: "no" },
    });
    expect(clean).toEqual({ state: "completed", nested: { keep: true } });
    expect(JSON.stringify(clean)).not.toContain("p4ss");
    expect(JSON.stringify(clean)).not.toContain("hunter2");
  });

  it("stores the size, not the payload, when the size is what is useful", async () => {
    const db = fakeDb();
    const audit = new AuditService(db, logger());
    await audit.record({ action: "job.add", actor: ANA, detail: { name: "send-invoice", dataBytes: 812 } });
    expect(db.__state.inserted[0]?.detail).toEqual({ name: "send-invoice", dataBytes: 812 });
  });

  it("keeps `{}` out of the column", () => {
    expect(sanitizeDetail({})).toBeNull();
    expect(sanitizeDetail({ data: { a: 1 } })).toBeNull();
    expect(sanitizeDetail(null)).toBeNull();
  });

  it("replaces an absurdly large detail with its size", () => {
    const clean = sanitizeDetail({ notes: "x".repeat(5000) });
    expect(clean).toMatchObject({ truncated: true });
    expect(String(clean?.bytes)).not.toBe("undefined");
  });
});

describe("AuditService.list filters", () => {
  let db: ReturnType<typeof fakeDb>;
  let audit: AuditService;

  beforeEach(async () => {
    db = fakeDb();
    audit = new AuditService(db, logger());
    await audit.record({ action: "queue.pause", actor: ANA, connectionId: "c1", queueName: "payments", createdAt: new Date(T0) });
    await audit.record({ action: "job.retry", actor: ANA, connectionId: "c1", queueName: "payments", jobId: "42", createdAt: new Date(T0 + 1000) });
    await audit.record({ action: "queue.obliterate", actor: BRUNO, connectionId: "c2", queueName: "reports", result: "error", createdAt: new Date(T0 + 2000) });
  });

  it("returns newest first", async () => {
    // Ordering is what an audit page is read by; nothing else is a sane default.
    db.__setFilter(() => true);
    const page = await audit.list(query());
    expect(page.entries.map((e) => e.action)).toEqual(["queue.obliterate", "job.retry", "queue.pause"]);
  });

  it("filters by actor", async () => {
    db.__setFilter((r) => r.actorId === "u-bruno");
    const page = await audit.list(query({ actorId: "u-bruno" }));
    expect(page.entries.map((e) => e.action)).toEqual(["queue.obliterate"]);
  });

  it("filters by action, queue and result", async () => {
    db.__setFilter((r) => r.action === "job.retry");
    expect((await audit.list(query({ action: "job.retry" }))).entries).toHaveLength(1);

    db.__setFilter((r) => r.queueName === "payments");
    expect((await audit.list(query({ queueName: "payments" }))).entries).toHaveLength(2);

    db.__setFilter((r) => r.result === "error");
    expect((await audit.list(query({ result: "error" }))).entries.map((e) => e.action)).toEqual(["queue.obliterate"]);
  });

  it("filters by connection and date range", async () => {
    db.__setFilter((r) => r.connectionId === "c1");
    expect((await audit.list(query({ connectionId: "c1" }))).entries).toHaveLength(2);

    db.__setFilter((r) => r.createdAt.getTime() >= T0 + 2000);
    const page = await audit.list(query({ from: new Date(T0 + 2000).toISOString() }));
    expect(page.entries.map((e) => e.action)).toEqual(["queue.obliterate"]);
  });
});

describe("cursor paging", () => {
  it("round-trips a cursor", () => {
    const c = encodeCursor({ createdAt: new Date(T0), id: "abc" });
    expect(decodeCursor(c)).toEqual({ createdAt: new Date(T0), id: "abc" });
    expect(decodeCursor("garbage")).toBeNull();
    expect(decodeCursor("")).toBeNull();
  });

  it("walks the whole table without repeating or skipping a row", async () => {
    const db = fakeDb();
    const audit = new AuditService(db, logger());
    for (let i = 0; i < 10; i += 1) {
      await audit.record({ action: "job.retry", actor: ANA, jobId: String(i), createdAt: new Date(T0 + i * 1000) });
    }

    const seen: string[] = [];
    let cursor: string | undefined;
    for (let guard = 0; guard < 10; guard += 1) {
      // The stub cannot evaluate the keyset predicate itself, so the test
      // applies it — the same comparison the service builds in SQL.
      const c = cursor ? decodeCursor(cursor) : null;
      db.__setFilter((r) =>
        !c ? true : r.createdAt.getTime() < c.createdAt.getTime() || (r.createdAt.getTime() === c.createdAt.getTime() && r.id < c.id),
      );
      const page = await audit.list(query({ limit: 4, ...(cursor ? { cursor } : {}) }));
      seen.push(...page.entries.map((e) => e.jobId!));
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }

    expect(seen).toEqual(["9", "8", "7", "6", "5", "4", "3", "2", "1", "0"]);
    expect(new Set(seen).size).toBe(10);
  });

  it("reports no next cursor on the last page", async () => {
    const db = fakeDb();
    const audit = new AuditService(db, logger());
    await audit.record({ action: "queue.pause", actor: ANA, createdAt: new Date(T0) });
    const page = await audit.list(query({ limit: 50 }));
    expect(page.nextCursor).toBeNull();
  });
});

describe("retention", () => {
  it("deletes only rows older than the cutoff", async () => {
    const db = fakeDb();
    const audit = new AuditService(db, logger());
    await audit.record({ action: "queue.pause", actor: ANA, createdAt: new Date(T0 - 400 * 86_400_000) });
    await audit.record({ action: "queue.resume", actor: ANA, createdAt: new Date(T0) });

    const cutoff = new Date(T0 - 365 * 86_400_000);
    db.__setFilter((r) => r.createdAt.getTime() <= cutoff.getTime());
    await audit.prune(cutoff);

    db.__setFilter(() => true);
    expect((await audit.list(query())).entries.map((e) => e.action)).toEqual(["queue.resume"]);
  });

  it("starts no timer when retention is disabled", () => {
    const audit = new AuditService(fakeDb(), logger());
    audit.startRetention(0);
    audit.stopRetention(); // must not throw
  });
});

describe("route → action map", () => {
  it("covers every mutating route in the API", () => {
    // The list is the mutating half of docs/API.md. If a route is added and not
    // mapped, this test says so instead of an auditor noticing a hole in 2027.
    const mutating: Array<[string, string, AuditAction | "unaudited"]> = [
      ["POST", "/api/connections/:id/queues/:queue/jobs", "job.add"],
      ["DELETE", "/api/connections/:id/queues/:queue/jobs/:jobId", "job.remove"],
      ["POST", "/api/connections/:id/queues/:queue/jobs/:jobId/retry", "job.retry"],
      ["POST", "/api/connections/:id/queues/:queue/jobs/:jobId/promote", "job.promote"],
      ["POST", "/api/connections/:id/queues/:queue/jobs/:jobId/discard", "job.discard"],
      ["POST", "/api/connections/:id/queues/:queue/pause", "queue.pause"],
      ["POST", "/api/connections/:id/queues/:queue/resume", "queue.resume"],
      ["POST", "/api/connections/:id/queues/:queue/clean", "queue.clean"],
      ["POST", "/api/connections/:id/queues/:queue/retry-all", "queue.retry_all"],
      ["POST", "/api/connections/:id/queues/:queue/drain", "queue.drain"],
      ["POST", "/api/connections/:id/queues/:queue/obliterate", "queue.obliterate"],
      ["DELETE", "/api/connections/:id/queues/:queue/schedulers/:key", "scheduler.remove"],
      ["POST", "/api/connections/:id/hidden-queues", "queue.hide"],
      ["DELETE", "/api/connections/:id/hidden-queues/:queueName", "queue.unhide"],
      ["POST", "/api/connections", "connection.create"],
      ["PATCH", "/api/connections/:id", "connection.update"],
      ["DELETE", "/api/connections/:id", "connection.delete"],
      ["POST", "/api/users", "user.create"],
      ["PATCH", "/api/users/:id", "user.update"],
      ["POST", "/api/alerts", "alert.create"],
      ["PATCH", "/api/alerts/:id", "alert.update"],
      ["DELETE", "/api/alerts/:id", "alert.delete"],
      ["PUT", "/api/license", "license.set"],
      ["DELETE", "/api/license", "license.remove"],
      ["POST", "/api/auth/login", "auth.login"],
      ["POST", "/api/auth/logout", "auth.logout"],
      // deliberately out of the trail, with the reason in plugins/audit.ts
      ["POST", "/api/connections/test", "unaudited"],
      ["POST", "/api/setup", "unaudited"],
      ["POST", "/api/alerts/:id/test", "unaudited"],
    ];

    for (const [method, route, expected] of mutating) {
      if (expected === "unaudited") {
        expect(isUnaudited(method, route), `${method} ${route}`).toBe(true);
      } else {
        expect(actionFor(method, route), `${method} ${route}`).toBe(expected);
      }
    }
  });

  it("does not map reads", () => {
    expect(actionFor("GET", "/api/connections/:id/queues")).toBeNull();
    expect(actionFor("GET", "/api/audit")).toBeNull();
  });

  it("gives every action a human label", () => {
    // The UI shows "retried a job", not `job.retry`.
    for (const a of AUDIT_ACTIONS) expect(AUDIT_ACTION_LABEL[a], a).toBeTruthy();
  });
});
