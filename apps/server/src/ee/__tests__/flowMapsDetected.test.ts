/**
 * Detected flow maps against a REAL Redis, with jobs written by bullmq's own
 * FlowProducer: the real sampleFlowEdges Lua must turn "a parent with two
 * children" into ONE detected map whose root is the parent.
 *
 * Redis: BULLPANE_TEST_REDIS_URL, or a throwaway one (helpers/testRedis.ts). A prefix
 * unique to this run, and its queues obliterated afterwards, so it never touches
 * anything else on a shared Redis. SQLite in a temp dir for the app's own data.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInspectorPool } from "@bullpane/redis-inspector";
import { createConnectionSchema, type Edition, type FlowMap, type FlowMapsResponse } from "@bullpane/shared";
import { FlowProducer, Queue } from "bullmq";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../app";
import { loadConfig } from "../../config";
import { createDatabase, type Database } from "../../db";
import { runMigrations } from "../../db/migrate";
import { testRedis } from "../../__tests__/helpers/testRedis";

const redis = testRedis(6397);
const REDIS_URL = redis.url;
const PREFIX = `bp-fm-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
/** children first: removing a child moves a waiting parent back to `wait`, so the parent goes last */
const QUEUES = ["fm-child-a", "fm-child-b", "fm-parent"];

const PRO: Edition = {
  tier: "pro",
  demo: false,
  features: { alerts: true, users: true, folders: true, flows: true, audit: true, sso: true, mcp: true },
  license: null,
  pricing: { monthlyUsd: 39, yearlyUsd: 390 },
  checkoutUrl: "",
};

let dir: string;
let database: Database;
let app: FastifyInstance;
let pool: ReturnType<typeof createInspectorPool>;
let connectionId: string;

const get = <T>(url: string): Promise<T> =>
  app.inject({ method: "GET", url: `/api${url}`, headers: { "x-test-user": "op" } }).then((r) => {
    if (r.statusCode >= 400) throw new Error(`${url} → ${r.statusCode} ${r.body}`);
    return r.json() as T;
  });

beforeAll(async () => {
  await redis.start();
  const connection = { url: REDIS_URL };
  const producer = new FlowProducer({ connection, prefix: PREFIX });
  // Workers are not started: the children wait, the parent waits for them —
  // exactly the state a stuck flow is in when someone opens the dashboard.
  await producer.add({
    name: "dispatch",
    queueName: "fm-parent",
    data: {},
    children: [
      { name: "voice", queueName: "fm-child-a", data: {} },
      { name: "email", queueName: "fm-child-b", data: {} },
    ],
  });
  await producer.close();

  dir = mkdtempSync(path.join(tmpdir(), "bullpane-fm-redis-"));
  const config = loadConfig({ SESSION_SECRET: "x".repeat(40), DEMO_MODE: "false", BULLPANE_DATA_DIR: dir, LOG_LEVEL: "silent" }, { warn: () => undefined });
  database = createDatabase(config.database);
  await runMigrations(database, { info: () => undefined, warn: () => undefined });
  pool = createInspectorPool({ discoveryTtlMs: 0, previewBytes: 2048 });
  app = await buildApp({ config, db: database.db, pool, logger: false, serveWeb: false });
  app.ctx.edition.getEdition = () => PRO;
  app.addHook("onRequest", async (request) => {
    if (request.headers["x-test-user"] === "op") {
      request.user = { id: "op", email: "op@acme.com", name: "op", role: "operator", createdAt: new Date().toISOString(), lastLoginAt: null, disabledAt: null };
    }
  });
  await app.ready();
  const created = await app.ctx.connections.create(createConnectionSchema.parse({ name: "local", url: REDIS_URL, prefix: PREFIX }));
  connectionId = created.id;
}, 30_000);

afterAll(async () => {
  app?.ctx.alertsEngine.stop();
  app?.ctx.edition.stop();
  await app?.close();
  await pool?.closeAll();
  await database?.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
  for (const name of QUEUES) {
    const q = new Queue(name, { connection: { url: REDIS_URL }, prefix: PREFIX });
    await q.obliterate({ force: true }).catch(() => undefined);
    await q.close();
  }
  redis.stop();
});

describe("detected flow maps on a real Redis", () => {
  it("a FlowProducer parent with two children is one detected map rooted at the parent", async () => {
    const list = await get<FlowMapsResponse>("/flow-maps");
    expect(list.detectedComplete).toBe(true);
    const detected = list.maps.filter((m) => m.kind === "detected");
    expect(detected).toHaveLength(1);
    expect(detected[0]).toMatchObject({ id: `detected:${connectionId}:fm-parent`, name: "fm-parent", connectionId, nodeCount: 3, edgeCount: 2 });

    const map = await get<FlowMap>(`/flow-maps/${encodeURIComponent(detected[0]!.id)}`);
    expect(map.nodes.map((n) => n.queueName).sort()).toEqual(["fm-child-a", "fm-child-b", "fm-parent"]);
    expect(map.nodes.every((n) => !n.missing)).toBe(true);
    expect(map.nodes.find((n) => n.queueName === "fm-child-a")!.counts.waiting).toBe(1);
    expect(map.edges.map((e) => [e.from, e.to, e.source]).sort()).toEqual([
      [`${connectionId}:fm-parent`, `${connectionId}:fm-child-a`, "detected"],
      [`${connectionId}:fm-parent`, `${connectionId}:fm-child-b`, "detected"],
    ]);
  });
});
