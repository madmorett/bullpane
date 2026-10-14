/**
 * MCP end to end, through the real Fastify app (`app.inject`): register a
 * client, authorize, consent, exchange the code, call /mcp. What matters here:
 *
 *  - effective access = min(admin ceiling, what the user approved, their role),
 *    evaluated on EVERY call (lowering the ceiling bites at once);
 *  - a tool is an /api call made as the user, so the route's guards, read-only
 *    mode and the audit log apply — and the audit row says `via: mcp`;
 *  - the OAuth edges: PKCE, single-use codes, refresh rotation with reuse
 *    detection, unregistered redirects never redirected to, free edition.
 *
 * No MySQL and no Redis: MemoryMcpStore, a fake drizzle-shaped db (connections,
 * settings, audit rows) and a fake inspector.
 */
import { createHash, randomBytes } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { Edition, Role } from "@bullpane/shared";
import { buildApp } from "../../app";
import { loadConfig } from "../../config";
import type { Db } from "../../db";
import type { AuditLogRow, UserRow } from "../../db/schema";
import { MemoryMcpStore } from "../mcp/store";
import { isAllowedRedirectUri, reachableFromCloud } from "../mcp/service";
import { mcpEffectiveAccess } from "@bullpane/shared";

const PUBLIC_URL = "https://bullpane.acme.com";
const REDIRECT = "https://claude.ai/api/mcp/auth_callback";

const CONNECTION = {
  id: "c1",
  name: "prod",
  url: "redis://localhost:6379",
  prefix: "bull",
  cluster: false,
  queueFilter: null,
  position: 0,
  createdAt: new Date("2024-01-01T00:00:00.000Z"),
};

function userRow(id: string, role: Role): UserRow {
  return {
    id,
    email: `${id}@acme.com`,
    name: id,
    passwordHash: "x",
    role,
    createdAt: new Date("2024-01-01T00:00:00.000Z"),
    lastLoginAt: null,
    disabledAt: null,
  };
}

function tableName(table: unknown): string {
  const sym = Object.getOwnPropertySymbols(table as object).find((s) => String(s).includes("Name"));
  return sym ? String((table as Record<symbol, unknown>)[sym]) : "";
}

/** Just enough drizzle for connections, settings and the audit log. */
function fakeDb(connectionRows: unknown[] = [CONNECTION]) {
  const audit: AuditLogRow[] = [];
  const settings = new Map<string, string>();
  let lastWhereValue: unknown;
  const db = {
    __audit: audit,
    __settings: settings,
    select: () => ({ from: (t: unknown) => chain(tableName(t)) }),
    selectDistinct: () => ({ from: (t: unknown) => chain(tableName(t)) }),
    insert: (t: unknown) => ({
      values(v: Record<string, unknown>) {
        const name = tableName(t);
        if (name === "audit_log") audit.push(v as unknown as AuditLogRow);
        if (name === "settings") settings.set(String(v.key), String(v.value));
        const p = Promise.resolve();
        return Object.assign(p, { onDuplicateKeyUpdate: () => Promise.resolve() });
      },
    }),
    delete: () => ({ where: () => Promise.resolve() }),
    update: () => ({ set: () => ({ where: () => Promise.resolve() }) }),
  };
  function chain(name: string) {
    const b = {
      where: (cond: unknown) => {
        lastWhereValue = cond;
        return b;
      },
      orderBy: () => b,
      limit: () => b,
      then(resolve: (rows: unknown[]) => unknown) {
        let rows: unknown[] = [];
        if (name === "connections") rows = connectionRows;
        if (name === "audit_log") rows = audit;
        if (name === "settings") {
          // The settings store only ever selects one key: find it in the condition.
          const key = JSON.stringify(lastWhereValue, (_k, v) => (typeof v === "object" && v !== null && "table" in v ? undefined : v));
          const hit = [...settings.entries()].find(([k]) => key.includes(`"${k}"`));
          rows = hit ? [{ key: hit[0], value: hit[1] }] : [];
        }
        return Promise.resolve(rows).then(resolve);
      },
    };
    return b;
  }
  return db as unknown as Db & { __audit: AuditLogRow[]; __settings: Map<string, string> };
}

function fakeInspector() {
  return {
    ping: vi.fn(async () => ({ ok: true, latencyMs: 1, redisVersion: "7.2.0", error: null })),
    retryJob: vi.fn(async () => undefined),
    removeJob: vi.fn(async () => undefined),
    pauseGroup: vi.fn(async () => undefined),
    promoteMatching: vi.fn(async () => ({ matched: 1, promoted: 1, rescheduled: 0, unchanged: 0, failed: [], failedCount: 0, scanned: 10, total: 10, nextCursor: null })),
    countMatching: vi.fn(async () => ({ matched: 42, scanned: 10, total: 10, nextCursor: null })),
    getJob: vi.fn(async (_q: string, id: string) => ({ id, name: "send-invoice", state: "failed", data: { invoice: 42 } })),
    searchJobs: vi.fn(async () => ({ jobs: [], nextCursor: null, scanned: 0, total: 0, skippedLargePayloads: 0 })),
  };
}

const PRO: Edition = {
  tier: "pro",
  demo: false,
  features: { alerts: true, users: true, folders: true, flows: true, audit: true, sso: true, mcp: true },
  license: null,
  pricing: { monthlyUsd: 39, yearlyUsd: 390 },
  checkoutUrl: "",
};
const FREE: Edition = { ...PRO, tier: "free", features: Object.fromEntries(Object.keys(PRO.features).map((k) => [k, false])) as Edition["features"] };

async function build(opts: { ceiling?: "off" | "read" | "write"; edition?: Edition; readOnly?: boolean; connections?: unknown[] } = {}) {
  const db = fakeDb(opts.connections);
  if (opts.ceiling) db.__settings.set("mcp.max_access", opts.ceiling);
  const users = new Map<string, UserRow>([
    ["admin", userRow("admin", "admin")],
    ["op", userRow("op", "operator")],
    ["viewer", userRow("viewer", "viewer")],
  ]);
  const store = new MemoryMcpStore((id) => users.get(id) ?? null);
  const inspector = fakeInspector();
  const pool = { get: () => inspector, evict: vi.fn(async () => undefined), closeAll: vi.fn(async () => undefined) } as never;
  const config = loadConfig(
    { SESSION_SECRET: "x".repeat(40), DEMO_MODE: "false", PUBLIC_URL, ...(opts.readOnly ? { BULLPANE_READ_ONLY: "true" } : {}) },
    { warn: () => undefined },
  );
  const app = await buildApp({ config, db, pool, logger: false, serveWeb: false, mcpStore: store });
  let edition = opts.edition ?? PRO;
  app.ctx.edition.getEdition = () => edition;
  // Stand-in for the session cookie: the dashboard user is named by a header.
  // An injected MCP call has no such header, so authPlugin's identity stands.
  app.addHook("onRequest", async (request) => {
    const id = request.headers["x-test-user"];
    if (typeof id === "string" && users.has(id)) {
      const u = users.get(id)!;
      request.user = { id: u.id, email: u.email, name: u.name, role: u.role, createdAt: u.createdAt.toISOString(), lastLoginAt: null, disabledAt: null };
    }
  });
  await app.ready();
  return { app, db, store, users, inspector, setEdition: (e: Edition) => (edition = e) };
}

type W = Awaited<ReturnType<typeof build>>;

function pkce() {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

async function register(w: W, redirect = REDIRECT): Promise<string> {
  const res = await w.app.inject({ method: "POST", url: "/oauth/register", payload: { client_name: "Claude", redirect_uris: [redirect] } });
  expect(res.statusCode).toBe(201);
  return res.json().client_id;
}

/** Runs authorize → consent; returns the consent decision's redirect URL. */
async function consent(w: W, clientId: string, user: string, access: "read" | "write", extra: Record<string, string> = {}) {
  const { verifier, challenge } = pkce();
  const q = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: REDIRECT,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: "st-1",
    scope: "queues:read queues:write",
    resource: `${PUBLIC_URL}/mcp`,
    ...extra,
  });
  const auth = await w.app.inject({ method: "GET", url: `/oauth/authorize?${q}` });
  expect(auth.statusCode).toBe(302);
  const location = new URL(auth.headers.location as string, PUBLIC_URL);
  const request = location.searchParams.get("request")!;
  const info = await w.app.inject({ method: "GET", url: `/api/mcp/consent?request=${encodeURIComponent(request)}`, headers: { "x-test-user": user } });
  const decision = await w.app.inject({
    method: "POST",
    url: "/api/mcp/consent",
    headers: { "x-test-user": user },
    payload: { request, approve: true, access },
  });
  expect(decision.statusCode).toBe(200);
  return { info: info.json(), redirectTo: new URL(decision.json().redirectTo), verifier };
}

async function connect(w: W, user: string, access: "read" | "write" = "write") {
  const clientId = await register(w);
  const { redirectTo, verifier, info } = await consent(w, clientId, user, access);
  const code = redirectTo.searchParams.get("code");
  expect(code, redirectTo.toString()).toBeTruthy();
  const tok = await w.app.inject({
    method: "POST",
    url: "/oauth/token",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    payload: new URLSearchParams({ grant_type: "authorization_code", code: code!, code_verifier: verifier, client_id: clientId, redirect_uri: REDIRECT }).toString(),
  });
  expect(tok.statusCode).toBe(200);
  return { clientId, info, ...(tok.json() as { access_token: string; refresh_token: string; scope: string }) };
}

let rpcId = 0;
async function rpc(w: W, token: string, method: string, params?: unknown) {
  const res = await w.app.inject({
    method: "POST",
    url: "/mcp",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "user-agent": "claude-test/1.0" },
    payload: { jsonrpc: "2.0", id: ++rpcId, method, ...(params !== undefined ? { params } : {}) },
  });
  return res;
}

async function toolNames(w: W, token: string): Promise<string[]> {
  return (await rpc(w, token, "tools/list")).json().result.tools.map((t: { name: string }) => t.name);
}

async function callTool(w: W, token: string, name: string, args: Record<string, unknown>) {
  return (await rpc(w, token, "tools/call", { name, arguments: args })).json().result as { content: { text: string }[]; isError?: boolean };
}

const JOB = { connection_id: "c1", queue: "payments", job_id: "7" };

describe("MCP: who can do what", () => {
  it("an admin with write runs a job action, and the audit row says it came through MCP", async () => {
    const w = await build({ ceiling: "write" });
    const { access_token, scope } = await connect(w, "admin", "write");
    expect(scope).toBe("queues:read queues:write");

    const init = (await rpc(w, access_token, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } })).json();
    expect(init.result.protocolVersion).toBe("2025-06-18");
    expect(init.result.capabilities.tools).toBeDefined();

    expect(await toolNames(w, access_token)).toContain("retry_job");
    const res = await callTool(w, access_token, "retry_job", JOB);
    expect(res.isError).toBeUndefined();
    expect(w.inspector.retryJob).toHaveBeenCalledWith("payments", "7");
    await w.app.close();

    const row = w.db.__audit.find((r) => r.action === "job.retry")!;
    expect(row.actorId).toBe("admin");
    // Acting through MCP caps an admin at operator: drain/obliterate are not reachable.
    expect(row.actorRole).toBe("operator");
    expect(row.detail).toMatchObject({ via: "mcp", mcpClient: "Claude" });
    // Where the MCP call came from, not the in-process inject.
    expect(row.userAgent).toBe("claude-test/1.0");
  });

  it("a viewer who approves write still only reads", async () => {
    const w = await build({ ceiling: "write" });
    const { access_token, scope, info } = await connect(w, "viewer", "write");
    expect(info.allowed).toBe("read");
    expect(scope).toBe("queues:read");
    const names = await toolNames(w, access_token);
    expect(names).toContain("get_job");
    expect(names).not.toContain("retry_job");
    const res = await callTool(w, access_token, "retry_job", JOB);
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toMatch(/needs write access/);
    expect(w.inspector.retryJob).not.toHaveBeenCalled();
    await w.app.close();
  });

  it("an operator who picks read gets read", async () => {
    const w = await build({ ceiling: "write" });
    const { access_token } = await connect(w, "op", "read");
    expect(await toolNames(w, access_token)).not.toContain("retry_job");
    await w.app.close();
  });

  it("the admin's ceiling caps everyone, and lowering it bites on the very next call", async () => {
    const w = await build({ ceiling: "write" });
    const { access_token } = await connect(w, "op", "write");
    expect(await toolNames(w, access_token)).toContain("retry_job");

    const put = await w.app.inject({ method: "PUT", url: "/api/mcp/settings", headers: { "x-test-user": "admin" }, payload: { maxAccess: "read" } });
    expect(put.statusCode).toBe(200);
    expect(await toolNames(w, access_token)).not.toContain("retry_job");

    await w.app.inject({ method: "PUT", url: "/api/mcp/settings", headers: { "x-test-user": "admin" }, payload: { maxAccess: "off" } });
    expect(await toolNames(w, access_token)).toEqual([]);
    const res = await callTool(w, access_token, "get_job", JOB);
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toMatch(/turned off/);
    await w.app.close();
    expect(w.db.__audit.some((r) => r.action === "mcp.settings_update")).toBe(true);
  });

  it("with MCP off, approving sends the client an access_denied", async () => {
    const w = await build({ ceiling: "off" });
    const clientId = await register(w);
    const { redirectTo } = await consent(w, clientId, "admin", "write");
    expect(redirectTo.searchParams.get("error")).toBe("access_denied");
    expect(redirectTo.searchParams.get("code")).toBeNull();
    expect(redirectTo.searchParams.get("state")).toBe("st-1");
    await w.app.close();
  });

  it("only an admin sets the ceiling", async () => {
    const w = await build({ ceiling: "read" });
    const res = await w.app.inject({ method: "PUT", url: "/api/mcp/settings", headers: { "x-test-user": "op" }, payload: { maxAccess: "write" } });
    expect(res.statusCode).toBe(403);
    await w.app.close();
  });

  it("read-only mode refuses the write and still lets people connect", async () => {
    const w = await build({ ceiling: "write", readOnly: true });
    const { access_token } = await connect(w, "admin", "write");
    const res = await callTool(w, access_token, "retry_job", JOB);
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toMatch(/read_only/);
    expect(w.inspector.retryJob).not.toHaveBeenCalled();
    await w.app.close();
  });

  it("drain, clean and obliterate are never tools: the client gets a dashboard link", async () => {
    const w = await build({ ceiling: "write" });
    const { access_token } = await connect(w, "admin", "write");
    const names = await toolNames(w, access_token);
    expect(names.some((n) => /drain|obliterate|clean/.test(n) && n !== "request_destructive_action")).toBe(false);
    const res = await callTool(w, access_token, "request_destructive_action", { connection_id: "c1", queue: "payments", action: "drain" });
    expect(JSON.parse(res.content[0]!.text).url).toBe(`${PUBLIC_URL}/c/c1/q/payments?confirm=drain`);
    await w.app.close();
  });

  it("previews with count_matching (read) and spreads with promote_matching", async () => {
    const w = await build({ ceiling: "write" });
    const { access_token } = await connect(w, "op", "write");
    const counted = await callTool(w, access_token, "count_matching", { connection_id: "c1", queue: "payments", group_id: "tenant-a" });
    expect(JSON.parse(counted.content[0]!.text)).toMatchObject({ matched: 42 });
    expect(w.inspector.countMatching).toHaveBeenCalledWith("payments", { groupId: "tenant-a" }, { cursor: null });
    const spread = { connection_id: "c1", queue: "payments", group_id: "tenant-a", spread_from: 1_000, spread_until: 3_601_000, spread_total: 42 };
    expect((await callTool(w, access_token, "promote_matching", spread)).isError).toBeUndefined();
    expect(w.inspector.promoteMatching).toHaveBeenCalledWith(
      "payments",
      { groupId: "tenant-a" },
      { cursor: null, limit: expect.any(Number), spread: { from: 1_000, until: 3_601_000, total: 42, offset: 0 } },
    );
    const half = await callTool(w, access_token, "promote_matching", { connection_id: "c1", queue: "payments", group_id: "tenant-a", spread_from: 1_000 });
    expect(half.isError).toBe(true);
    await w.app.close();
  });

  it("promotes every delayed job of a group with promote_matching", async () => {
    const w = await build({ ceiling: "write" });
    const { access_token } = await connect(w, "op", "write");
    const res = await callTool(w, access_token, "promote_matching", { connection_id: "c1", queue: "payments", group_id: "tenant-a" });
    expect(res.isError).toBeUndefined();
    expect(w.inspector.promoteMatching).toHaveBeenCalledWith("payments", { groupId: "tenant-a" }, { cursor: null, limit: expect.any(Number), spread: undefined });
    const neither = await callTool(w, access_token, "promote_matching", { connection_id: "c1", queue: "payments" });
    expect(neither.isError).toBe(true);
    await w.app.close();
  });

  it("pauses a BullMQ Pro group as a tool, and drains one only through a dashboard link", async () => {
    const w = await build({ ceiling: "write" });
    const { access_token } = await connect(w, "admin", "write");
    const paused = await callTool(w, access_token, "pause_group", { connection_id: "c1", queue: "payments", group_id: "tenant-a" });
    expect(paused.isError).toBeUndefined();
    expect(w.inspector.pauseGroup).toHaveBeenCalledWith("payments", "tenant-a");
    const link = await callTool(w, access_token, "request_destructive_action", { connection_id: "c1", queue: "payments", action: "drain_group", group_id: "tenant-a" });
    expect(JSON.parse(link.content[0]!.text).url).toBe(`${PUBLIC_URL}/c/c1/q/payments/groups/tenant-a?confirm=drain`);
    const noGroup = await callTool(w, access_token, "request_destructive_action", { connection_id: "c1", queue: "payments", action: "drain_group" });
    expect(noGroup.isError).toBe(true);
    await w.app.close();
    expect(w.db.__audit.find((r) => r.action === "group.pause")?.detail).toMatchObject({ groupId: "tenant-a", via: "mcp" });
  });

  it("reads come back from the same /api route the dashboard uses", async () => {
    const w = await build({ ceiling: "read" });
    const { access_token } = await connect(w, "viewer", "read");
    const res = await callTool(w, access_token, "get_job", JOB);
    expect(JSON.parse(res.content[0]!.text)).toMatchObject({ id: "7", name: "send-invoice" });
    const bad = await callTool(w, access_token, "get_job", { connection_id: "c1" });
    expect(bad.isError).toBe(true);
    expect(bad.content[0]!.text).toMatch(/Invalid arguments/);
    await w.app.close();
  });

  it("lists a group's delayed jobs with search_jobs and group_id, no query needed", async () => {
    const w = await build({ ceiling: "read" });
    const { access_token } = await connect(w, "viewer", "read");
    const res = await callTool(w, access_token, "search_jobs", { connection_id: "c1", queue: "payments", group_id: "tenant-a", state: "delayed" });
    expect(res.isError).toBeUndefined();
    expect(w.inspector.searchJobs).toHaveBeenCalledWith("payments", "delayed", "", { cursor: null, limit: 50, groupId: "tenant-a" });
    const neither = await callTool(w, access_token, "search_jobs", { connection_id: "c1", queue: "payments" });
    expect(neither.isError).toBe(true);
    expect(neither.content[0]!.text).toMatch(/query or group_id is required/);
    await w.app.close();
  });
});

describe("MCP: flow map tools", () => {
  /** The service behind the routes, stubbed: what is asserted is that each tool reaches its route with the right input. */
  function stubFlowMaps(w: W) {
    const map = { id: "m1", kind: "manual", name: "Checkout", nodes: [], edges: [] };
    const fm = w.app.ctx.flowMaps;
    return {
      list: vi.spyOn(fm, "list").mockResolvedValue({ maps: [], detectedComplete: true }),
      get: vi.spyOn(fm, "get").mockResolvedValue(map as never),
      create: vi.spyOn(fm, "create").mockResolvedValue(map as never),
      update: vi.spyOn(fm, "update").mockResolvedValue(map as never),
      remove: vi.spyOn(fm, "remove").mockResolvedValue(undefined),
      addNode: vi.spyOn(fm, "addNode").mockResolvedValue(map as never),
      removeNode: vi.spyOn(fm, "removeNode").mockResolvedValue(map as never),
      addEdge: vi.spyOn(fm, "addEdge").mockResolvedValue(map as never),
      removeEdge: vi.spyOn(fm, "removeEdge").mockResolvedValue(map as never),
      copy: vi.spyOn(fm, "copy").mockResolvedValue(map as never),
    };
  }

  it("every tool reaches its route; connection_id defaults to the only connection", async () => {
    const w = await build({ ceiling: "write" });
    const fm = stubFlowMaps(w);
    const { access_token } = await connect(w, "op", "write");
    const ok = async (name: string, args: Record<string, unknown>) => {
      const res = await callTool(w, access_token, name, args);
      expect(res.isError, `${name}: ${res.content[0]?.text}`).toBeUndefined();
      return res;
    };

    expect(JSON.parse((await ok("list_flow_maps", {})).content[0]!.text)).toEqual({ maps: [], detectedComplete: true });
    await ok("get_flow_map", { map_id: "detected:c1:dispatch" });
    expect(fm.get).toHaveBeenCalledWith("detected:c1:dispatch");
    await ok("create_flow_map", { name: "Checkout", parent_id: "p1" });
    expect(fm.create).toHaveBeenCalledWith({ name: "Checkout", parentId: "p1" });
    await ok("update_flow_map", { map_id: "m1", parent_id: null, name: "Outbound" });
    expect(fm.update).toHaveBeenCalledWith("m1", { name: "Outbound", parentId: null });
    await ok("delete_flow_map", { map_id: "m1" });
    expect(fm.remove).toHaveBeenCalledWith("m1");
    await ok("add_flow_queue", { map_id: "m1", queue: "voice" });
    expect(fm.addNode).toHaveBeenCalledWith("m1", { connectionId: "c1", queueName: "voice" });
    // The node id is built from connection + queue, split later on the FIRST ":".
    await ok("remove_flow_queue", { map_id: "m1", queue: "bull:voice" });
    expect(fm.removeNode).toHaveBeenCalledWith("m1", "c1:bull:voice");
    await ok("add_flow_edge", { map_id: "m1", from_queue: "checkout", to_queue: "payment-capture", label: "per item" });
    expect(fm.addEdge).toHaveBeenCalledWith("m1", {
      from: { connectionId: "c1", queueName: "checkout" },
      to: { connectionId: "c1", queueName: "payment-capture" },
      label: "per item",
    });
    await ok("remove_flow_edge", { map_id: "m1", edge_id: "e1" });
    expect(fm.removeEdge).toHaveBeenCalledWith("m1", "e1");
    await ok("copy_flow_map", { map_id: "detected:c1:dispatch", name: "Mine" });
    expect(fm.copy).toHaveBeenCalledWith("detected:c1:dispatch", { name: "Mine" });
    await w.app.close();
  });

  it("drawing needs write access: a read connection lists and reads maps only", async () => {
    const w = await build({ ceiling: "write" });
    const fm = stubFlowMaps(w);
    const { access_token } = await connect(w, "op", "read");
    const names = await toolNames(w, access_token);
    expect(names).toEqual(expect.arrayContaining(["list_flow_maps", "get_flow_map"]));
    for (const write of ["create_flow_map", "update_flow_map", "delete_flow_map", "add_flow_queue", "remove_flow_queue", "add_flow_edge", "remove_flow_edge", "copy_flow_map"]) {
      expect(names).not.toContain(write);
    }
    const res = await callTool(w, access_token, "add_flow_edge", { map_id: "m1", from_queue: "a", to_queue: "b" });
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toMatch(/needs write access/);
    expect(fm.addEdge).not.toHaveBeenCalled();
    await w.app.close();
  });

  it("with several connections an end without a connection is refused, and an edge may cross connections", async () => {
    const w = await build({ ceiling: "write", connections: [CONNECTION, { ...CONNECTION, id: "c2", name: "ai", position: 1 }] });
    const fm = stubFlowMaps(w);
    const { access_token } = await connect(w, "op", "write");

    for (const args of [
      { map_id: "m1", from_queue: "order-placed", to_queue: "email-send" },
      { map_id: "m1", from_queue: "order-placed", to_queue: "email-send", from_connection_id: "c1" },
    ]) {
      const res = await callTool(w, access_token, "add_flow_edge", args);
      expect(res.isError).toBe(true);
      expect(res.content[0]!.text).toMatch(/connection_id is required.*2 connections.*prod \(c1\).*ai \(c2\).*list_connections/);
    }
    const queue = await callTool(w, access_token, "add_flow_queue", { map_id: "m1", queue: "voice" });
    expect(queue.isError).toBe(true);
    expect(fm.addEdge).not.toHaveBeenCalled();
    expect(fm.addNode).not.toHaveBeenCalled();

    const res = await callTool(w, access_token, "add_flow_edge", {
      map_id: "m1",
      from_queue: "order-placed",
      from_connection_id: "c1",
      to_queue: "email-send",
      to_connection_id: "c2",
    });
    expect(res.isError).toBeUndefined();
    expect(fm.addEdge).toHaveBeenCalledWith("m1", {
      from: { connectionId: "c1", queueName: "order-placed" },
      to: { connectionId: "c2", queueName: "email-send" },
    });
    await w.app.close();
  });
});

describe("MCP: tokens", () => {
  it("answers 401 with the resource metadata URL when there is no valid token", async () => {
    const w = await build({ ceiling: "write" });
    const res = await w.app.inject({ method: "POST", url: "/mcp", payload: { jsonrpc: "2.0", id: 1, method: "ping" } });
    expect(res.statusCode).toBe(401);
    expect(res.headers["www-authenticate"]).toContain(`resource_metadata="${PUBLIC_URL}/.well-known/oauth-protected-resource"`);
    const forged = await rpc(w, "bpat.eyJnIjoiZyIsImUiOjk5OTk5OTk5OTl9.c2lnbmF0dXJl", "ping");
    expect(forged.statusCode).toBe(401);
    await w.app.close();
  });

  it("publishes the discovery documents a client needs", async () => {
    const w = await build();
    const pr = (await w.app.inject({ method: "GET", url: "/.well-known/oauth-protected-resource" })).json();
    expect(pr).toMatchObject({ resource: `${PUBLIC_URL}/mcp`, authorization_servers: [PUBLIC_URL] });
    const as = (await w.app.inject({ method: "GET", url: "/.well-known/oauth-authorization-server" })).json();
    expect(as).toMatchObject({ issuer: PUBLIC_URL, code_challenge_methods_supported: ["S256"], registration_endpoint: `${PUBLIC_URL}/oauth/register` });
    await w.app.close();
  });

  it("burns a code on first use and refuses a wrong PKCE verifier", async () => {
    const w = await build({ ceiling: "write" });
    const clientId = await register(w);
    const { redirectTo, verifier: rightVerifier } = await consent(w, clientId, "admin", "write");
    const code = redirectTo.searchParams.get("code")!;
    const exchange = (verifier: string) =>
      w.app.inject({
        method: "POST",
        url: "/oauth/token",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        payload: new URLSearchParams({ grant_type: "authorization_code", code, code_verifier: verifier, client_id: clientId }).toString(),
      });
    const wrong = await exchange(randomBytes(32).toString("base64url"));
    expect(wrong.statusCode).toBe(400);
    expect(wrong.json().error).toBe("invalid_grant");
    // A failed attempt burned it: even the right verifier is too late now.
    const again = await exchange(rightVerifier);
    expect(again.json().error).toBe("invalid_grant");
    await w.app.close();
  });

  it("rotates refresh tokens, and a replayed one ends the whole grant", async () => {
    const w = await build({ ceiling: "write" });
    const { clientId, refresh_token, access_token } = await connect(w, "admin", "write");
    const refresh = (token: string) =>
      w.app.inject({
        method: "POST",
        url: "/oauth/token",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        payload: new URLSearchParams({ grant_type: "refresh_token", refresh_token: token, client_id: clientId }).toString(),
      });
    const first = await refresh(refresh_token);
    expect(first.statusCode).toBe(200);
    expect(first.json().refresh_token).not.toBe(refresh_token);

    const replay = await refresh(refresh_token);
    expect(replay.json().error).toBe("invalid_grant");
    // The leak response: the grant is gone, so even the newest tokens stop working.
    expect((await refresh(first.json().refresh_token)).json().error).toBe("invalid_grant");
    expect((await rpc(w, access_token, "ping")).statusCode).toBe(401);
    await w.app.close();
  });

  it("disconnecting a client in Settings → MCP kills its token at once", async () => {
    const w = await build({ ceiling: "write" });
    const { access_token } = await connect(w, "op", "write");
    const grants = (await w.app.inject({ method: "GET", url: "/api/mcp/grants", headers: { "x-test-user": "op" } })).json();
    expect(grants).toHaveLength(1);
    expect(grants[0]).toMatchObject({ clientName: "Claude", redirectHost: "claude.ai", access: "write", userId: "op" });

    // Someone else's grant is invisible and cannot be revoked by a non-admin.
    const other = await w.app.inject({ method: "DELETE", url: `/api/mcp/grants/${grants[0].id}`, headers: { "x-test-user": "viewer" } });
    expect(other.statusCode).toBe(404);

    const del = await w.app.inject({ method: "DELETE", url: `/api/mcp/grants/${grants[0].id}`, headers: { "x-test-user": "op" } });
    expect(del.statusCode).toBe(200);
    expect((await rpc(w, access_token, "ping")).statusCode).toBe(401);
    await w.app.close();
    expect(w.db.__audit.some((r) => r.action === "mcp.revoke")).toBe(true);
  });

  it("a disabled user's tokens stop working", async () => {
    const w = await build({ ceiling: "write" });
    const { access_token } = await connect(w, "op", "write");
    w.users.set("op", { ...w.users.get("op")!, disabledAt: new Date() });
    expect((await rpc(w, access_token, "ping")).statusCode).toBe(401);
    await w.app.close();
  });
});

describe("MCP: authorize edges", () => {
  it("never redirects to a URI the client did not register", async () => {
    const w = await build({ ceiling: "write" });
    const clientId = await register(w);
    const { challenge } = pkce();
    const q = new URLSearchParams({ response_type: "code", client_id: clientId, redirect_uri: "https://evil.example/cb", code_challenge: challenge, code_challenge_method: "S256" });
    const res = await w.app.inject({ method: "GET", url: `/oauth/authorize?${q}` });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toMatch(/^\/oauth\/consent\?error=/);
    await w.app.close();
  });

  it("sends a missing PKCE and a foreign resource back to the client as errors", async () => {
    const w = await build({ ceiling: "write" });
    const clientId = await register(w);
    const noPkce = await w.app.inject({ method: "GET", url: `/oauth/authorize?${new URLSearchParams({ response_type: "code", client_id: clientId, redirect_uri: REDIRECT })}` });
    expect(new URL(noPkce.headers.location as string).searchParams.get("error")).toBe("invalid_request");

    const { challenge } = pkce();
    const foreign = await w.app.inject({
      method: "GET",
      url: `/oauth/authorize?${new URLSearchParams({ response_type: "code", client_id: clientId, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: "S256", resource: "https://other.example/mcp" })}`,
    });
    expect(new URL(foreign.headers.location as string).searchParams.get("error")).toBe("invalid_target");
    await w.app.close();
  });

  it("refuses redirect URIs that would leak the code", async () => {
    const w = await build();
    for (const uri of ["http://claude.ai/cb", "javascript:alert(1)", "https://claude.ai/cb#frag"]) {
      const res = await w.app.inject({ method: "POST", url: "/oauth/register", payload: { redirect_uris: [uri] } });
      expect(res.statusCode, uri).toBe(400);
    }
    await w.app.close();
  });

  it("is Pro: the free edition says so instead of half-working", async () => {
    const w = await build({ edition: FREE });
    const reg = await w.app.inject({ method: "POST", url: "/oauth/register", payload: { redirect_uris: [REDIRECT] } });
    expect(reg.statusCode).toBe(403);
    expect(reg.json().error_description).toMatch(/Pro/);
    const settings = await w.app.inject({ method: "GET", url: "/api/mcp/settings", headers: { "x-test-user": "admin" } });
    expect(settings.statusCode).toBe(402);
    await w.app.close();
  });
});

describe("MCP helpers", () => {
  it("effective access is the lowest of ceiling, grant and role", () => {
    expect(mcpEffectiveAccess("write", "write", "admin")).toBe("write");
    expect(mcpEffectiveAccess("write", "write", "viewer")).toBe("read");
    expect(mcpEffectiveAccess("read", "write", "admin")).toBe("read");
    expect(mcpEffectiveAccess("write", "read", "operator")).toBe("read");
    expect(mcpEffectiveAccess("off", "write", "admin")).toBe("off");
  });

  it("accepts https, loopback http (Claude Code) and app schemes as redirects", () => {
    expect(isAllowedRedirectUri("https://claude.ai/api/mcp/auth_callback")).toBe(true);
    expect(isAllowedRedirectUri("http://localhost:33418/callback")).toBe(true);
    expect(isAllowedRedirectUri("http://127.0.0.1:9000/cb")).toBe(true);
    expect(isAllowedRedirectUri("cursor://anysphere.cursor-retrieval/oauth/callback")).toBe(true);
    expect(isAllowedRedirectUri("http://10.0.0.5/cb")).toBe(false);
    expect(isAllowedRedirectUri("data:text/html,hi")).toBe(false);
  });

  it("knows when claude.ai cannot reach the install", () => {
    expect(reachableFromCloud("https://queues.acme.com")).toBe(true);
    expect(reachableFromCloud("http://queues.acme.com")).toBe(false);
    expect(reachableFromCloud("https://localhost:3000")).toBe(false);
    expect(reachableFromCloud("https://10.1.2.3")).toBe(false);
    expect(reachableFromCloud("https://bullpane.internal")).toBe(false);
  });
});
