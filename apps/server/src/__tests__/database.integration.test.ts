/**
 * The whole server against a REAL database, once per dialect.
 *
 * Every other suite stubs `db`, which proves the services build the right
 * calls but not that a database accepts them. This one runs migrations, boots
 * the real app, unlocks Pro with a real signed license and drives every table
 * through its HTTP routes, then reads the rows back.
 *
 *   SQLite  always (a temp file — the zero-setup default).
 *   MySQL   when BULLPANE_TEST_MYSQL_URL is set, e.g.
 *           mysql://root:root@127.0.0.1:3306  — a throwaway database is
 *           created on that server and dropped afterwards.
 *
 * Redis is only needed for the connection status probe; connections point at
 * BULLPANE_TEST_REDIS_URL (default redis://127.0.0.1:6379) and nothing here
 * fails if it is down.
 */
import { generateKeyPairSync } from "node:crypto";
import { copyFileSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInspectorPool } from "@bullpane/redis-inspector";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import mysql from "mysql2/promise";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../app";
import { loadConfig } from "../config";
import { createDatabase, type Database } from "../db";
import { MIGRATIONS_DIR, runMigrations } from "../db/migrate";
import { signLicense } from "../license";
import { DrizzleMcpStore } from "../ee/mcp/store";
import { DrizzleSettingsStore } from "../services/settings-store";

const MYSQL_URL = process.env.BULLPANE_TEST_MYSQL_URL;
const REDIS_URL = process.env.BULLPANE_TEST_REDIS_URL ?? "redis://127.0.0.1:6379";
const SESSION_SECRET = "integration-".repeat(4);
const quietLog = { info: () => undefined, warn: () => undefined };

interface Target {
  name: "sqlite" | "mysql";
  /** DATABASE_URL for loadConfig ("" = unset = SQLite default) */
  setup(): Promise<{ env: Record<string, string>; teardown(): Promise<void> }>;
}

const targets: Target[] = [
  {
    name: "sqlite",
    async setup() {
      const dir = mkdtempSync(path.join(tmpdir(), "bullpane-it-"));
      return {
        env: { BULLPANE_DATA_DIR: dir },
        teardown: async () => rmSync(dir, { recursive: true, force: true }),
      };
    },
  },
];
if (MYSQL_URL) {
  targets.push({
    name: "mysql",
    async setup() {
      const dbName = `bullpane_it_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
      const admin = await mysql.createConnection(MYSQL_URL);
      await admin.query(`CREATE DATABASE \`${dbName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
      const url = new URL(MYSQL_URL);
      url.pathname = `/${dbName}`;
      return {
        env: { DATABASE_URL: url.toString() },
        teardown: async () => {
          await admin.query(`DROP DATABASE \`${dbName}\``);
          await admin.end();
        },
      };
    },
  });
}

describe.each(targets)("$name: the server on a real database", (target) => {
  const keys = generateKeyPairSync("ed25519");
  const publicKeyB64 = keys.publicKey.export({ type: "spki", format: "der" }).toString("base64");
  let env: Record<string, string>;
  let teardown: () => Promise<void>;
  let database: Database;
  let app: FastifyInstance;
  let pool: ReturnType<typeof createInspectorPool>;
  let cookie = "";

  const config = () =>
    loadConfig(
      { SESSION_SECRET, LICENSE_PUBLIC_KEY_B64: publicKeyB64, DEMO_MODE: "false", LOG_LEVEL: "silent", ...env },
      { warn: () => undefined },
    );

  async function boot(): Promise<void> {
    const cfg = config();
    database = createDatabase(cfg.database);
    await runMigrations(database, quietLog);
    pool = createInspectorPool({ discoveryTtlMs: 30_000, previewBytes: 2048 });
    app = await buildApp({ config: cfg, db: database.db, pool, logger: false, serveWeb: false });
    await app.ctx.edition.load();
    await app.ready();
  }

  async function shutdown(): Promise<void> {
    app.ctx.alertsEngine.stop();
    app.ctx.edition.stop();
    await app.close();
    await pool.closeAll();
    await database.close();
  }

  async function call(method: string, url: string, payload?: unknown): Promise<LightMyRequestResponse> {
    return app.inject({
      method: method as never,
      url: `/api${url}`,
      payload: payload as never,
      headers: cookie ? { cookie } : {},
    });
  }

  async function ok<T = unknown>(method: string, url: string, payload?: unknown): Promise<T> {
    const res = await call(method, url, payload);
    if (res.statusCode >= 400) throw new Error(`${method} ${url} → ${res.statusCode} ${res.body}`);
    return (res.body ? res.json() : undefined) as T;
  }

  async function waitFor(check: () => Promise<boolean>, timeoutMs = 2_000): Promise<void> {
    const until = Date.now() + timeoutMs;
    while (!(await check())) {
      if (Date.now() > until) return;
      await new Promise((r) => setTimeout(r, 20));
    }
  }

  function captureCookie(res: LightMyRequestResponse): void {
    const c = res.cookies.find((x) => x.name === "bullpane_session" || x.name.includes("session"));
    if (c) cookie = `${c.name}=${c.value}`;
  }

  async function rows(sql: string): Promise<Record<string, unknown>[]> {
    return database.rows(sql);
  }

  beforeAll(async () => {
    ({ env, teardown } = await target.setup());
    await boot();
  }, 60_000);

  afterAll(async () => {
    await shutdown().catch(() => undefined);
    await teardown();
  });

  // --- schema ----------------------------------------------------------------

  it("migrates once, records it, and a second run is a no-op", async () => {
    const applied = await rows("SELECT name FROM _migrations");
    expect(applied.length).toBeGreaterThan(0);
    const again = await runMigrations(database, quietLog);
    expect(again.applied).toEqual([]);
  });

  it("seeds the starting alert rule with a parsed JSON condition", async () => {
    const [rule] = await app.ctx.alerts.listRows();
    expect(rule?.id).toBe("default-failure-rate");
    expect(rule?.scopeType).toBe("global");
    expect(rule?.enabled).toBe(true);
    expect(rule?.firing).toBe(false);
    expect(rule?.condition).toEqual({ kind: "failed_rate_above", percent: 10, windowMinutes: 15, minSample: 20 });
    expect(rule?.channels).toEqual([]);
    expect(rule?.createdAt).toBeInstanceOf(Date);
    expect(Math.abs(Date.now() - rule!.createdAt.getTime())).toBeLessThan(5 * 60_000);
  });

  // --- free edition: no login --------------------------------------------------

  let connA = "";
  let connB = "";
  let connC = "";

  it("free edition: creates connections and keeps their order", async () => {
    expect((await ok<{ tier: string }>("GET", "/edition")).tier).toBe("free");
    const a = await ok<{ id: string; cluster: boolean }>("POST", "/connections", { name: "Alpha", url: REDIS_URL, prefix: "it-a" });
    const b = await ok<{ id: string }>("POST", "/connections", { name: "Beta", url: REDIS_URL, prefix: "it-b", cluster: false });
    const c = await ok<{ id: string }>("POST", "/connections", { name: "Gamma", url: REDIS_URL, prefix: "it-c", queueFilter: "pay*" });
    connA = a.id;
    connB = b.id;
    connC = c.id;
    expect(a.cluster).toBe(false);
    const list = await ok<Array<{ id: string; name: string; queueFilter: string | null }>>("GET", "/connections");
    expect(list.map((x) => x.name)).toEqual(["Alpha", "Beta", "Gamma"]);
    expect(list[2]?.queueFilter).toBe("pay*");
  });

  it("free edition: a Postgres connection keeps its kind and schema", async () => {
    // Nothing listens on port 1: the row must be stored even though the probe fails.
    const pg = await ok<{ id: string; kind: string; prefix: string; status: { ok: boolean } }>("POST", "/connections", {
      name: "Jobs PG",
      kind: "postgres",
      url: "postgres://app:secret@127.0.0.1:1/app",
      prefix: "jobs",
    });
    expect(pg).toMatchObject({ kind: "postgres", prefix: "jobs", status: { ok: false } });
    const row = await app.ctx.connections.getRow(pg.id);
    expect(row.kind).toBe("postgres");
    expect((await call("PATCH", `/connections/${pg.id}`, { url: "redis://127.0.0.1:6379" })).statusCode).toBe(400);
    await ok("DELETE", `/connections/${pg.id}`);
  });

  it("free edition: reorders inside a transaction", async () => {
    const reordered = await ok<Array<{ id: string }>>("PUT", "/connections/reorder", { ids: [connC, connA] });
    expect(reordered.map((x) => x.id)).toEqual([connC, connA, connB]);
    const positions = await rows("SELECT id, position FROM connections ORDER BY position");
    expect(positions.map((r) => Number(r.position))).toEqual([0, 1, 2]);
  });

  it("free edition: updates a connection, booleans included", async () => {
    const updated = await ok<{ name: string; cluster: boolean }>("PATCH", `/connections/${connB}`, { name: "Beta 2", cluster: true });
    expect(updated.name).toBe("Beta 2");
    expect(updated.cluster).toBe(true);
    await ok("PATCH", `/connections/${connB}`, { cluster: false });
    const row = await app.ctx.connections.getRow(connB);
    expect(row.cluster).toBe(false);
  });

  it("free edition: hides and unhides queues idempotently", async () => {
    await ok("POST", `/connections/${connA}/hidden-queues`, { queueName: "emails" });
    const twice = await ok<Array<{ queueName: string; hiddenAt: string }>>("POST", `/connections/${connA}/hidden-queues`, {
      queueName: "emails",
    });
    expect(twice).toHaveLength(1);
    expect(new Date(twice[0]!.hiddenAt).getTime()).toBeGreaterThan(Date.now() - 60_000);
    await ok("DELETE", `/connections/${connA}/hidden-queues/emails`);
    await ok("DELETE", `/connections/${connA}/hidden-queues/emails`);
    expect(await app.ctx.connections.isQueueHidden(connA, "emails")).toBe(false);
    await ok("POST", `/connections/${connA}/hidden-queues`, { queueName: "emails" });
  });

  // Queue names are case-sensitive in BullMQ. KNOWN DIVERGENCE: the MySQL
  // tables use utf8mb4_unicode_ci, which compares them case-insensitively, so
  // there `Reports` and `reports` collide. SQLite compares bytes, as BullMQ does.
  it.runIf(target.name === "sqlite")("keeps queue names that differ only in case apart", async () => {
    await ok("POST", `/connections/${connA}/hidden-queues`, { queueName: "Reports" });
    await ok("POST", `/connections/${connA}/hidden-queues`, { queueName: "reports" });
    expect(await app.ctx.connections.hiddenQueueNames(connA)).toEqual(new Set(["emails", "Reports", "reports"]));
    await ok("DELETE", `/connections/${connA}/hidden-queues/reports`);
    expect(await app.ctx.connections.isQueueHidden(connA, "Reports")).toBe(true);
    expect(await app.ctx.connections.isQueueHidden(connA, "reports")).toBe(false);
  });

  it("free edition: settings round-trip through the upsert", async () => {
    const saved = await ok<{ waitingAbove: number; failedAbove: number }>("PUT", "/settings/attention", { waitingAbove: 500, failedAbove: 7 });
    expect(saved).toMatchObject({ waitingAbove: 500, failedAbove: 7 });
    await ok("PUT", "/settings/attention", { waitingAbove: 600, failedAbove: 8 });
    expect(await ok("GET", "/settings/attention")).toMatchObject({ waitingAbove: 600, failedAbove: 8 });
    const store = new DrizzleSettingsStore(database.db);
    expect(await store.get("nope")).toBeNull();
    await store.set("k", "v1");
    await store.set("k", "v2");
    expect(await store.get("k")).toBe("v2");
    await store.delete("k");
    expect(await store.get("k")).toBeNull();
  });

  // --- Pro: license, first admin, sessions --------------------------------------

  it("stores a Pro license and keeps it across a restart", async () => {
    const key = signLicense(
      { licensee: "Integration", email: "it@example.com", plan: "pro", issuedAt: Date.now(), expiresAt: null },
      keys.privateKey,
    );
    const edition = await ok<{ tier: string }>("PUT", "/license", { key });
    expect(edition.tier).toBe("pro");
    // Now Pro: the same request needs a login.
    expect((await call("PUT", "/license", { key })).statusCode).toBe(401);

    await shutdown();
    await boot();
    expect((await ok<{ tier: string }>("GET", "/edition")).tier).toBe("pro");
    expect((await call("GET", "/connections")).statusCode).toBe(401);
  });

  it("creates the first admin and signs in with a session", async () => {
    expect(await ok<{ needsSetup: boolean }>("GET", "/setup/status")).toMatchObject({ needsSetup: true });
    const res = await call("POST", "/setup", { email: "Admin@Example.com", name: "Ada Admin", password: "correct horse" });
    expect(res.statusCode).toBeLessThan(300);
    captureCookie(res);
    const me = await ok<{ user: { email: string; role: string } }>("GET", "/auth/me");
    expect(me.user).toMatchObject({ email: "admin@example.com", role: "admin" });
    expect((await call("POST", "/setup", { email: "x@example.com", name: "X", password: "whatever1" })).statusCode).toBe(409);
  });

  it("logs in case-insensitively and refuses a wrong password", async () => {
    const saved = cookie;
    cookie = "";
    expect((await call("POST", "/auth/login", { email: "admin@example.com", password: "wrong pass" })).statusCode).toBe(401);
    const res = await call("POST", "/auth/login", { email: "ADMIN@example.com", password: "correct horse" });
    expect(res.statusCode).toBe(200);
    captureCookie(res);
    expect(cookie).not.toBe(saved);
    const [user] = await rows("SELECT last_login_at FROM users");
    expect(user?.last_login_at).not.toBeNull();
  });

  let operatorId = "";

  it("manages users: unique email, roles, disable revokes sessions", async () => {
    const op = await ok<{ id: string; role: string }>("POST", "/users", {
      email: "op@example.com",
      name: "Oscar",
      role: "operator",
      password: "operator pass",
    });
    operatorId = op.id;
    const dup = await call("POST", "/users", { email: "OP@example.com", name: "Dup", role: "viewer", password: "something1" });
    expect(dup.statusCode).toBe(409);
    await ok("POST", "/users", { email: "sso-only@example.com", name: "Sam", role: "viewer" });

    expect((await ok<{ role: string }>("PATCH", `/users/${operatorId}`, { role: "viewer" })).role).toBe("viewer");
    await ok("PATCH", `/users/${operatorId}`, { role: "operator" });

    // Operator signs in → has a session row.
    const admin = cookie;
    cookie = "";
    captureCookie(await call("POST", "/auth/login", { email: "op@example.com", password: "operator pass" }));
    const opCookie = cookie;
    cookie = admin;
    const [{ n: before }] = (await rows(`SELECT COUNT(*) AS n FROM sessions WHERE user_id = '${operatorId}'`)) as [{ n: unknown }];
    expect(Number(before)).toBe(1);

    const disabled = await ok<{ disabledAt: string | null }>("PATCH", `/users/${operatorId}`, { disabled: true });
    expect(disabled.disabledAt).not.toBeNull();
    const [{ n: after }] = (await rows(`SELECT COUNT(*) AS n FROM sessions WHERE user_id = '${operatorId}'`)) as [{ n: unknown }];
    expect(Number(after)).toBe(0);
    cookie = opCookie;
    expect((await call("GET", "/auth/me")).statusCode).toBe(401);
    cookie = "";
    expect((await call("POST", "/auth/login", { email: "op@example.com", password: "operator pass" })).statusCode).toBeGreaterThanOrEqual(400);
    cookie = admin;
    expect((await ok<{ disabledAt: string | null }>("PATCH", `/users/${operatorId}`, { disabled: false })).disabledAt).toBeNull();

    const me = await ok<{ user: { id: string } }>("GET", "/auth/me");
    expect((await call("PATCH", `/users/${me.user.id}`, { disabled: true })).statusCode).toBeGreaterThanOrEqual(400);
    const users = await ok<Array<{ email: string }>>("GET", "/users");
    expect(users.map((u) => u.email).sort()).toEqual(["admin@example.com", "op@example.com", "sso-only@example.com"]);
  });

  it("purges expired sessions by date", async () => {
    const me = await ok<{ user: { id: string } }>("GET", "/auth/me");
    const old = await app.ctx.sessions.create(me.user.id, new Date(Date.now() - 400 * 86_400_000));
    expect(old.expiresAt.getTime()).toBeLessThan(Date.now());
    await app.ctx.sessions.purgeExpired();
    const left = await rows(`SELECT id FROM sessions WHERE id = '${old.id}'`);
    expect(left).toHaveLength(0);
    expect((await call("GET", "/auth/me")).statusCode).toBe(200);
  });

  // --- Pro features ---------------------------------------------------------------

  let folderId = "";

  it("folders: nest, rename, reposition, assign queues, delete", async () => {
    const parent = await ok<{ id: string }>("POST", "/folders", { name: "Payments", color: "#ff0000" });
    const child = await ok<{ id: string; parentId: string | null }>("POST", "/folders", { name: "Refunds", parentId: parent.id });
    folderId = parent.id;
    expect(child.parentId).toBe(parent.id);
    await ok("PATCH", `/folders/${child.id}`, { name: "Refunds EU", position: 3, color: null });
    const withQueues = await ok<{ queues: Array<{ queueName: string }> }>("PUT", `/folders/${parent.id}/queues`, {
      queues: [
        { connectionId: connA, queueName: "charge" },
        { connectionId: connA, queueName: "charge" },
        { connectionId: connB, queueName: "settle" },
      ],
    });
    expect(withQueues.queues.map((q) => q.queueName).sort()).toEqual(["charge", "settle"]);
    const list = await ok<Array<{ id: string; name: string; color: string | null; position: number }>>("GET", "/folders");
    expect(list.find((f) => f.id === child.id)).toMatchObject({ name: "Refunds EU", color: null, position: 3 });
    await ok("DELETE", `/folders/${child.id}`);
    expect((await ok<unknown[]>("GET", "/folders")).length).toBe(1);
  });

  let alertId = "";

  it("alerts: every scope, JSON columns and booleans round-trip", async () => {
    const queue = await ok<{ id: string; scope: unknown; condition: unknown; channels: unknown; enabled: boolean }>("POST", "/alerts", {
      name: "Backlog",
      scope: { type: "queue", connectionId: connA, queueName: "charge" },
      condition: { kind: "waiting_above", threshold: 1000 },
      channels: [{ type: "webhook", url: "https://hooks.example.com/x", headers: { "x-token": "t" } }],
      cooldownMinutes: 10,
    });
    alertId = queue.id;
    expect(queue.scope).toEqual({ type: "queue", connectionId: connA, queueName: "charge" });
    expect(queue.condition).toEqual({ kind: "waiting_above", threshold: 1000 });
    expect(queue.channels).toEqual([{ type: "webhook", url: "https://hooks.example.com/x", headers: { "x-token": "t" } }]);
    await ok("POST", "/alerts", { name: "Folder", scope: { type: "folder", folderId }, condition: { kind: "failed_above", threshold: 5 } });
    await ok("POST", "/alerts", { name: "Conn", scope: { type: "connection", connectionId: connB }, condition: { kind: "waiting_above", threshold: 9 } });
    await ok("POST", "/alerts", { name: "Disabled", enabled: false, scope: { type: "global" }, condition: { kind: "waiting_above", threshold: 1 } });

    const patched = await ok<{ enabled: boolean; condition: unknown }>("PATCH", `/alerts/${alertId}`, {
      enabled: false,
      condition: { kind: "failed_rate_above", percent: 2.5, windowMinutes: 30, minSample: 50 },
    });
    expect(patched.enabled).toBe(false);
    expect(patched.condition).toEqual({ kind: "failed_rate_above", percent: 2.5, windowMinutes: 30, minSample: 50 });
    await ok("PATCH", `/alerts/${alertId}`, { enabled: true });

    expect((await app.ctx.alerts.listRows({ enabledOnly: true })).map((r) => r.name)).not.toContain("Disabled");
    expect(await app.ctx.alerts.count()).toBe(5);
  });

  it("alerts: engine state, events, filters and pruning", async () => {
    const firedAt = new Date("2026-03-04T05:06:07.891Z");
    await app.ctx.alerts.setState(alertId, { firing: true, lastFiredAt: firedAt });
    const row = await app.ctx.alerts.getRow(alertId);
    expect(row.firing).toBe(true);
    expect(row.lastFiredAt?.toISOString()).toBe(firedAt.toISOString());

    for (let i = 0; i < 5; i++) {
      await app.ctx.alerts.recordEvent({
        alertId: i < 3 ? alertId : "other",
        alertName: "Backlog",
        connectionId: connA,
        queueName: "charge",
        kind: "waiting_above",
        status: i % 2 ? "resolved" : "fired",
        message: `event ${i}`,
        value: i + 0.5,
      });
    }
    const all = await ok<Array<{ value: number | null }>>("GET", "/alerts/events?limit=100");
    expect(all).toHaveLength(5);
    expect(all.map((e) => e.value).sort()).toEqual([0.5, 1.5, 2.5, 3.5, 4.5]);
    expect(await ok<unknown[]>("GET", `/alerts/events?alertId=${alertId}`)).toHaveLength(3);
    expect(await ok<unknown[]>("GET", "/alerts/events?limit=2")).toHaveLength(2);
    await app.ctx.alerts.pruneEvents(new Date(Date.now() + 1000));
    expect(await ok<unknown[]>("GET", "/alerts/events")).toHaveLength(0);
  });

  it("flows: manual edges are unique per connection", async () => {
    const edge = await ok<{ id: string; label: string | null }>("POST", "/flow-edges", { connectionId: connA, from: "charge", to: "settle", label: "on success" });
    expect(edge.label).toBe("on success");
    expect((await call("POST", "/flow-edges", { connectionId: connA, from: "charge", to: "settle" })).statusCode).toBe(409);
    await ok("POST", "/flow-edges", { connectionId: connB, from: "charge", to: "settle" });
    await ok("DELETE", `/flow-edges/${edge.id}`);
    expect((await call("DELETE", `/flow-edges/${edge.id}`)).statusCode).toBe(404);
  });

  it("sso: provider config is JSON, the secret is encrypted, settings persist", async () => {
    const created = await ok<{ id: string; hasSecret: boolean; enabled: boolean }>("POST", "/sso/providers", {
      kind: "oidc",
      name: "Okta",
      config: { issuer: "https://acme.okta.test", clientId: "c1", clientSecret: "PLAINTEXT-SECRET", scopes: ["openid", "email"] },
    });
    expect(created).toMatchObject({ hasSecret: true, enabled: true });
    const [raw] = await rows(`SELECT secret_enc FROM sso_providers WHERE id = '${created.id}'`);
    expect(String(raw?.secret_enc)).not.toContain("PLAINTEXT-SECRET");

    await ok("PATCH", `/sso/providers/${created.id}`, { config: { issuer: "https://acme2.okta.test" } });
    const row = await app.ctx.sso.getRow(created.id);
    expect(row.config).toMatchObject({ issuer: "https://acme2.okta.test", clientId: "c1" });
    expect(row.updatedAt.getTime()).toBeGreaterThanOrEqual(row.createdAt.getTime());

    const settings = await ok<{ requireSso: boolean; autoProvision: boolean; autoProvisionDomains: string[] }>("PUT", "/sso/settings", {
      requireSso: true,
      autoProvision: true,
      autoProvisionDomains: ["@Acme.com"],
    });
    expect(settings).toMatchObject({ requireSso: true, autoProvision: true, autoProvisionDomains: ["acme.com"] });

    const provisioned = await app.ctx.sso.provisionUser({ email: "New.Person@acme.com", name: "New Person", emailVerified: true });
    expect(provisioned).toMatchObject({ email: "new.person@acme.com", role: "viewer" });
    expect(await app.ctx.sso.provisionUser({ email: "x@evil.com", name: null, emailVerified: true })).toBeNull();
    expect((await app.ctx.sso.resolveUser("NEW.PERSON@acme.com"))?.email).toBe("new.person@acme.com");

    expect((await call("DELETE", `/sso/providers/${created.id}`)).statusCode).toBe(409);
    await ok("PUT", "/sso/settings", { requireSso: false });
    await ok("DELETE", `/sso/providers/${created.id}`);
  });

  it("mcp: OAuth store — single-use codes, refresh rotation, joins, purges", async () => {
    const store = new DrizzleMcpStore(database.db);
    const me = await ok<{ user: { id: string } }>("GET", "/auth/me");
    const t = new Date("2026-05-06T07:08:09.123Z");

    await store.insertClient({ id: "client-1", name: "Claude", redirectUris: ["https://claude.ai/cb", "http://localhost:1/cb"], createdAt: t });
    await store.insertClient({ id: "client-old", name: "Abandoned", redirectUris: [], createdAt: new Date(t.getTime() - 86_400_000) });
    expect(await store.getClient("client-1")).toEqual({
      id: "client-1",
      name: "Claude",
      redirectUris: ["https://claude.ai/cb", "http://localhost:1/cb"],
      createdAt: t,
    });
    expect(await store.getClient("nope")).toBeNull();
    expect(await store.countClients()).toBe(2);

    const code = { codeHash: "h-code", clientId: "client-1", userId: me.user.id, access: "read" as const, redirectUri: "https://claude.ai/cb", codeChallenge: "c".repeat(43), expiresAt: new Date(Date.now() + 60_000) };
    await store.insertCode(code);
    // Single use: the first caller gets the row, the second gets nothing.
    const [first, second] = await Promise.all([store.consumeCode("h-code"), store.consumeCode("h-code")]);
    expect([first, second].filter(Boolean)).toHaveLength(1);
    expect(first ?? second).toMatchObject({ codeHash: "h-code", userId: me.user.id, access: "read" });
    expect(await store.consumeCode("h-code")).toBeNull();
    await store.insertCode({ ...code, codeHash: "h-expired", expiresAt: new Date(Date.now() - 1000) });
    await store.purgeExpiredCodes(new Date());
    expect(await store.consumeCode("h-expired")).toBeNull();

    await store.insertGrant({ id: "grant-1", clientId: "client-1", userId: me.user.id, access: "read", refreshHash: "r1", prevRefreshHash: null, refreshExpiresAt: new Date(Date.now() + 86_400_000), createdAt: t, lastUsedAt: null });
    expect((await store.findGrantByRefresh("r1"))?.id).toBe("grant-1");
    // Rotation is conditional: only the holder of the current token wins.
    expect(await store.rotateRefresh("grant-1", "r1", "r2", new Date(Date.now() + 86_400_000))).toBe(true);
    expect(await store.rotateRefresh("grant-1", "r1", "r3", new Date(Date.now() + 86_400_000))).toBe(false);
    expect(await store.findGrantByRefresh("r1")).toBeNull();
    expect((await store.findGrantByPrevRefresh("r1"))?.id).toBe("grant-1");

    const used = new Date("2026-05-07T00:00:00.456Z");
    await store.touchGrant("grant-1", used);
    const withUser = await store.getGrantWithUser("grant-1");
    expect(withUser?.clientName).toBe("Claude");
    expect(withUser?.redirectUris).toEqual(["https://claude.ai/cb", "http://localhost:1/cb"]);
    expect(withUser?.user.id).toBe(me.user.id);
    expect(withUser?.grant.lastUsedAt?.toISOString()).toBe(used.toISOString());
    expect(await store.listGrants(null)).toHaveLength(1);
    expect(await store.listGrants(me.user.id)).toHaveLength(1);
    expect(await store.listGrants("someone-else")).toHaveLength(0);

    // Clients that never got a grant are purged; the one in use stays.
    await store.purgeUnusedClients(new Date(t.getTime() + 1));
    expect(await store.getClient("client-old")).toBeNull();
    expect(await store.getClient("client-1")).not.toBeNull();

    await store.deleteGrantsForUser(me.user.id);
    expect(await store.getGrantWithUser("grant-1")).toBeNull();
    await store.insertGrant({ id: "grant-2", clientId: "client-1", userId: me.user.id, access: "write", refreshHash: "r9", prevRefreshHash: null, refreshExpiresAt: new Date(Date.now() + 1000), createdAt: t, lastUsedAt: null });
    await store.deleteGrant("grant-2");
    expect(await store.listGrants(null)).toHaveLength(0);
  });

  // --- audit -----------------------------------------------------------------------

  it("audit: every mutation above left a row with its actor", async () => {
    // Rows are written by an onResponse hook, i.e. after inject() resolved.
    await waitFor(async () => (await ok<{ entries: Array<{ action: string }> }>("GET", "/audit?limit=200")).entries.some((e) => e.action === "sso.provider_delete"));
    const page = await ok<{ entries: Array<{ action: string; actorEmail: string | null }> }>("GET", "/audit?limit=200");
    const actions = new Set(page.entries.map((e) => e.action));
    for (const expected of [
      "connection.create",
      "connection.update",
      "queue.hide",
      "queue.unhide",
      "attention.thresholds_update",
      "license.set",
      "auth.login",
      "user.create",
      "user.update",
      "user.disable",
      "user.enable",
      "alert.create",
      "alert.update",
      "sso.provider_create",
      "sso.provider_update",
      "sso.provider_delete",
    ]) {
      expect(actions.has(expected as never), `missing ${expected}`).toBe(true);
    }
    expect(page.entries.some((e) => e.actorEmail === "admin@example.com")).toBe(true);
    const actors = await ok<Array<{ email: string | null }>>("GET", "/audit/actors");
    expect(actors.some((a) => a.email === "admin@example.com")).toBe(true);
  });

  it("audit: keyset paging is exact when many rows share a millisecond", async () => {
    await app.ctx.audit.prune(new Date(Date.now() + 1000));
    const at = new Date("2026-01-02T03:04:05.678Z");
    for (let i = 0; i < 23; i++) {
      await app.ctx.audit.record({
        action: "queue.pause",
        connectionId: connA,
        queueName: `q${i % 3}`,
        createdAt: i < 20 ? at : new Date(at.getTime() + i),
        detail: { reason: `r${i}`, nested: { n: i, ok: true } },
      });
    }
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const qs: URLSearchParams = new URLSearchParams({ limit: "5", ...(cursor ? { cursor } : {}) });
      const page: { entries: Array<{ id: string }>; nextCursor: string | null } = await ok("GET", `/audit?${qs.toString()}`);
      seen.push(...page.entries.map((e) => e.id));
      cursor = page.nextCursor;
      pages++;
    } while (cursor && pages < 20);
    expect(seen).toHaveLength(23);
    expect(new Set(seen).size).toBe(23);

    const filtered = await ok<{ entries: Array<{ queueName: string; detail: { nested: { ok: boolean } } }> }>(
      "GET",
      `/audit?queueName=q1&connectionId=${connA}&from=${encodeURIComponent(at.toISOString())}`,
    );
    expect(filtered.entries.length).toBeGreaterThan(0);
    expect(filtered.entries.every((e) => e.queueName === "q1")).toBe(true);
    expect(filtered.entries[0]?.detail.nested.ok).toBe(true);

    const csv = await call("GET", "/audit/export?limit=200");
    expect(csv.statusCode).toBe(200);
    expect(csv.body.split("\n").length).toBeGreaterThan(20);

    await app.ctx.audit.prune(new Date(at.getTime() + 5));
    expect((await ok<{ entries: unknown[] }>("GET", "/audit?limit=200")).entries.length).toBeLessThan(23);
  });

  // --- concurrency, cleanup, persistence ----------------------------------------------

  it("survives concurrent writes (requests, engine state, a transaction) without busy errors", async () => {
    const work: Promise<unknown>[] = [];
    for (let i = 0; i < 40; i++) {
      work.push(app.ctx.audit.record({ action: "queue.resume", connectionId: connA, queueName: "c" }));
      work.push(app.ctx.alerts.setState(alertId, { firing: i % 2 === 0, lastFiredAt: new Date() }));
      work.push(ok("PUT", "/settings/attention", { waitingAbove: 100 + i, failedAbove: 1 }));
      if (i % 10 === 0) work.push(ok("PUT", "/connections/reorder", { ids: i % 20 ? [connA, connB, connC] : [connC, connB, connA] }));
      work.push(ok("GET", "/connections"));
    }
    const results = await Promise.allSettled(work);
    const failed = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
    expect(failed.map((f) => String(f.reason))).toEqual([]);
    const positions = await rows("SELECT position FROM connections ORDER BY position");
    expect(positions.map((r) => Number(r.position))).toEqual([0, 1, 2]);
    const [{ n }] = (await rows("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'queue.resume'")) as [{ n: unknown }];
    expect(Number(n)).toBe(40);
  });

  it("deleting a connection removes everything that pointed at it", async () => {
    await ok("DELETE", `/connections/${connA}`);
    for (const table of ["folder_queues", "hidden_queues", "alerts", "flow_edges"]) {
      const left = await rows(`SELECT * FROM ${table} WHERE connection_id = '${connA}'`);
      expect(left, table).toHaveLength(0);
    }
    expect(await rows(`SELECT * FROM folder_queues WHERE connection_id = '${connB}'`)).toHaveLength(1);
    expect((await call("GET", `/connections/${connA}/hidden-queues`)).statusCode).toBe(404);
  });

  it("keeps everything after a restart", async () => {
    // Only what the database holds. `measurement` is the alerts engine's memory
    // of its last tick (null right after a boot), and `firing`/`lastFiredAt` are
    // written by that engine whenever a tick happens to run — comparing them
    // across a restart races the engine. Their persistence is covered above.
    const alertRules = async () =>
      (await ok<Array<Record<string, unknown>>>("GET", "/alerts")).map(({ measurement, firing, lastFiredAt, ...rule }) => rule);
    const before = {
      users: await ok<unknown[]>("GET", "/users"),
      connections: (await ok<Array<{ id: string }>>("GET", "/connections")).map((c) => c.id),
      folders: await ok<unknown[]>("GET", "/folders"),
      alerts: await alertRules(),
      attention: await ok("GET", "/settings/attention"),
    };
    await shutdown();
    await boot();
    expect(await ok<unknown[]>("GET", "/users")).toEqual(before.users);
    expect((await ok<Array<{ id: string }>>("GET", "/connections")).map((c) => c.id)).toEqual(before.connections);
    expect(await ok<unknown[]>("GET", "/folders")).toEqual(before.folders);
    expect(await alertRules()).toEqual(before.alerts);
    expect(await ok("GET", "/settings/attention")).toEqual(before.attention);
  });
});

/**
 * An install that ran 0.5.1 already has connections, all Redis, and no `kind`
 * column. Upgrading must add the column and leave every existing row a Redis
 * connection, on both dialects.
 */
describe.each(targets)("$name: upgrading a 0.5.1 database adds the connection kind", (target) => {
  const KIND_MIGRATION = { sqlite: "0003_connection_kind.sql", mysql: "0010_connection_kind.sql" } as const;
  let env: Record<string, string>;
  let teardown: () => Promise<void>;
  let database: Database;

  beforeAll(async () => {
    ({ env, teardown } = await target.setup());
    database = createDatabase(loadConfig({ SESSION_SECRET, LOG_LEVEL: "silent", ...env }, { warn: () => undefined }).database);
  }, 60_000);

  afterAll(async () => {
    await database?.close().catch(() => undefined);
    await teardown();
  });

  it("existing rows become redis connections and keep working", async () => {
    // 1. the database as 0.5.1 left it: every migration except the kind one
    const dialectDir = path.join(MIGRATIONS_DIR, database.dialect);
    const before = mkdtempSync(path.join(tmpdir(), "bullpane-mig-"));
    for (const f of readdirSync(dialectDir)) {
      if (f !== KIND_MIGRATION[database.dialect]) copyFileSync(path.join(dialectDir, f), path.join(before, f));
    }
    await runMigrations(database, quietLog, before);
    rmSync(before, { recursive: true, force: true });
    const now = database.dialect === "sqlite" ? Date.now() : new Date();
    await database.exec(
      "INSERT INTO connections (id, name, url, prefix, cluster, queue_filter, position, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      ["old-1", "Production", REDIS_URL, "bull", 0, null, 0, now],
    );

    // 2. the upgrade
    const { applied } = await runMigrations(database, quietLog);
    expect(applied).toEqual([KIND_MIGRATION[database.dialect]]);
    const [row] = await database.rows("SELECT kind, prefix FROM connections WHERE id = 'old-1'");
    expect(row).toMatchObject({ kind: "redis", prefix: "bull" });

    // 3. the app reads it as a Redis connection
    const cfg = loadConfig({ SESSION_SECRET, DEMO_MODE: "false", LOG_LEVEL: "silent", ...env }, { warn: () => undefined });
    const pool = createInspectorPool({ discoveryTtlMs: 30_000, previewBytes: 2048 });
    const app = await buildApp({ config: cfg, db: database.db, pool, logger: false, serveWeb: false });
    await app.ctx.edition.load();
    await app.ready();
    try {
      const res = await app.inject({ method: "GET", url: "/api/connections" });
      expect(res.json()).toEqual([expect.objectContaining({ id: "old-1", kind: "redis", prefix: "bull", name: "Production" })]);
    } finally {
      app.ctx.alertsEngine.stop();
      app.ctx.edition.stop();
      await app.close();
      await pool.closeAll();
    }
  });
});
