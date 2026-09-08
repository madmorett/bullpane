/**
 * The audit hook against the REAL Fastify app.
 *
 * The unit test (audit.test.ts) checks the route→action map against strings I
 * typed. That proves nothing about whether those strings are the patterns
 * Fastify actually reports in `request.routeOptions.url` — a single wrong
 * segment and the row silently never gets written. So this test boots
 * `buildApp()` with fakes and calls the routes through `app.inject()`.
 *
 * What it pins down:
 *  - a mutating call produces exactly one audit row, with the derived action,
 *    actor, connection, queue and job filled in from the route;
 *  - a GET produces none (the dashboard polls; auditing reads is noise);
 *  - a REFUSED call is still recorded, with result "error";
 *  - the handler's enrichment lands in `detail` (clean's `removed` count), and
 *    the job payload does NOT;
 *  - a failed login is recorded as `auth.login_failed`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
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
  lastLoginAt: null,
};

/** drizzle-shaped stub: connections + users reads, audit_log writes. */
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

/** An inspector whose write methods all succeed. */
function fakeInspector() {
  return {
    ping: vi.fn(async () => ({ ok: true, latencyMs: 1, redisVersion: "7.2.0", error: null })),
    pauseQueue: vi.fn(async () => undefined),
    resumeQueue: vi.fn(async () => undefined),
    obliterateQueue: vi.fn(async () => undefined),
    cleanQueue: vi.fn(async () => ({ removed: 3412 })),
    retryJob: vi.fn(async () => undefined),
    addJob: vi.fn(async () => ({ id: "job-9" })),
    discoverQueues: vi.fn(async () => ["payments"]),
    getQueueStats: vi.fn(async () => ({})),
  };
}

async function build(role: "admin" | "operator" | "viewer" = "admin") {
  const db = fakeDb();
  const inspector = fakeInspector();
  const pool = { get: () => inspector, evict: vi.fn(async () => undefined), closeAll: vi.fn(async () => undefined) } as never;
  const config = loadConfig({ SESSION_SECRET: "x".repeat(40), DEMO_MODE: "false" }, { warn: () => undefined });
  const app = await buildApp({ config, db, pool, logger: false, serveWeb: false });

  // Pro is required for the /audit routes; the hook itself is not gated.
  vi.spyOn(app.ctx.edition, "getEdition").mockReturnValue({
    tier: "pro",
    demo: false,
    features: { alerts: true, users: true, folders: true, flows: true, audit: true, sso: true },
    license: null,
    pricing: { monthlyUsd: 19, yearlyUsd: 149 },
    checkoutUrl: "",
  });
  // Log in as whoever the test asks for, without a real session.
  app.addHook("onRequest", async (request) => {
    request.user = { ...ADMIN, role, createdAt: ADMIN.createdAt.toISOString(), lastLoginAt: null };
  });
  await app.ready();
  return { app, db, inspector };
}

let world: Awaited<ReturnType<typeof build>>;
const rows = (): AuditLogRow[] => world.db.__audit;

async function close(app: FastifyInstance) {
  await app.close();
}

describe("audit hook on the real app", () => {
  beforeEach(async () => {
    world = await build();
  });

  it("records a queue pause with the action derived from the route", async () => {
    const res = await world.app.inject({ method: "POST", url: "/api/connections/c1/queues/payments/pause" });
    expect(res.statusCode).toBe(200);
    await close(world.app);

    expect(rows()).toHaveLength(1);
    const row = rows()[0]!;
    // If the pattern in ROUTE_ACTIONS were wrong, `action` would be missing and
    // the row would never exist — which is what this assertion is for.
    expect(row.action).toBe("queue.pause");
    expect(row.queueName).toBe("payments");
    expect(row.connectionId).toBe("c1");
    expect(row.connectionName).toBe("prod");
    expect(row.actorId).toBe("u-admin");
    expect(row.actorEmail).toBe("admin@acme.com");
    expect(row.actorRole).toBe("admin");
    expect(row.result).toBe("ok");
  });

  it("records nothing for a GET", async () => {
    await world.app.inject({ method: "GET", url: "/api/connections" });
    await world.app.inject({ method: "GET", url: "/api/audit" });
    await close(world.app);
    expect(rows()).toHaveLength(0);
  });

  it("carries the handler's enrichment into detail (how many jobs were cleaned)", async () => {
    const res = await world.app.inject({
      method: "POST",
      url: "/api/connections/c1/queues/payments/clean",
      payload: { state: "completed", grace: 3600000, limit: 5000 },
    });
    expect(res.statusCode).toBe(200);
    await close(world.app);

    const row = rows()[0]!;
    expect(row.action).toBe("queue.clean");
    // The hook alone could never know "3412"; only the handler can.
    expect(row.detail).toMatchObject({ state: "completed", removed: 3412, limit: 5000 });
  });

  it("records the job id and the payload SIZE, never the payload", async () => {
    const res = await world.app.inject({
      method: "POST",
      url: "/api/connections/c1/queues/payments/jobs",
      payload: { name: "charge", data: { cpf: "123.456.789-00", card: "4111111111111111" } },
    });
    expect(res.statusCode).toBe(201);
    await close(world.app);

    const row = rows()[0]!;
    expect(row.action).toBe("job.add");
    expect(row.jobId).toBe("job-9");
    expect(row.detail).toMatchObject({ name: "charge" });
    // THE privacy assertion, on the real request path.
    const serialised = JSON.stringify(row);
    expect(serialised).not.toContain("123.456.789-00");
    expect(serialised).not.toContain("4111111111111111");
    expect(row.detail?.data).toBeUndefined();
  });

  it("records a REFUSED action — an operator denied obliterate is a finding", async () => {
    const w = await build("operator");
    const res = await w.app.inject({ method: "POST", url: "/api/connections/c1/queues/payments/obliterate" });
    expect(res.statusCode).toBe(403);
    await close(w.app);

    const row = w.db.__audit[0]!;
    expect(row.action).toBe("queue.obliterate");
    expect(row.result).toBe("error");
    expect(row.errorMessage).toContain("forbidden");
    expect(row.actorRole).toBe("operator");
  });

  it("records a failed login as auth.login_failed, with the email and no password", async () => {
    const w = await build();
    const res = await w.app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "ghost@acme.com", password: "wrong-password-12345" },
    });
    expect(res.statusCode).toBe(401);
    await close(w.app);

    const row = w.db.__audit[0]!;
    expect(row.action).toBe("auth.login_failed");
    expect(row.result).toBe("error");
    expect(row.detail).toEqual({ email: "ghost@acme.com" });
    expect(JSON.stringify(row)).not.toContain("wrong-password-12345");
  });

  it("does not audit the connection test ping", async () => {
    const w = await build();
    await w.app.inject({ method: "POST", url: "/api/connections/test", payload: { url: "redis://localhost:6379" } });
    await close(w.app);
    expect(w.db.__audit).toHaveLength(0);
  });

  it("an audit insert failure never breaks the action", async () => {
    const w = await build();
    // The trade-off, made explicit: the operator's pause must still succeed.
    vi.spyOn(w.app.ctx.audit, "record").mockImplementation(async () => {
      throw new Error("this should never escape");
    });
    const res = await w.app.inject({ method: "POST", url: "/api/connections/c1/queues/payments/resume" });
    // The hook awaits record(); a throwing record must not turn 200 into 500.
    expect(res.statusCode).toBe(200);
    await close(w.app);
  });
});
