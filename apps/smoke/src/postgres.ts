/**
 * Smoke test of the Postgres backend, end to end:
 *
 *   pnpm smoke:postgres
 *
 * Real Postgres, real BullMQ workers, the real server, a real browser. Nothing
 * is mocked. Sections:
 *   1. every feature through the HTTP API (Pro edition, so Pro features too)
 *   2. non-interference: reads must not slow the workers and must not lock
 *   3. the browser journey: add a connection, read, search, remove, ...
 *   4. the free edition: the same reads with no login, Pro routes locked
 *
 * Postgres: BULLPANE_SMOKE_PG_URL, else postgres://postgres:bullpane@127.0.0.1:5440/bullpane,
 * else a throwaway `postgres:16-alpine` container started (and removed) here.
 * Every run works in its own schemas (`smoke_<random>`) and drops them.
 *
 *   5. environments: PgBouncer (2 configs), TLS, a read-only role, MySQL app DB
 *      (throwaway Docker containers; skipped without Docker)
 *
 * Env: SMOKE_SKIP=ui,interference,free,environments · SMOKE_PHASE_MS (default 15000) ·
 * SMOKE_SCREENSHOTS (dir) · SMOKE_CHROMIUM (path to a Chromium binary)
 */
import { execFileSync, execSync } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import pg from "pg";
import { Abort, assert, check, heading, info, summary } from "./harness.js";
import { runCleanup, runFunctional } from "./functional.js";
import { runInterference } from "./interference.js";
import { dropSchema, resetSchema, seed, SEED } from "./seed.js";
import { Api, REPO_ROOT, startServer, type RunningServer } from "./server.js";
import { runUi } from "./ui.js";
import { runEnvironments } from "./environments.js";

const skip = new Set((process.env.SMOKE_SKIP ?? "").split(",").map((s) => s.trim()).filter(Boolean));
const ADMIN = { email: "admin@smoke.test", password: "smoke-password-1" };

async function reachable(url: string): Promise<boolean> {
  const c = new pg.Client({ connectionString: url, connectionTimeoutMillis: 2000 });
  try {
    await c.connect();
    await c.end();
    return true;
  } catch {
    return false;
  }
}

async function postgres(): Promise<{ url: string; stop: () => void }> {
  const explicit = process.env.BULLPANE_SMOKE_PG_URL;
  const fallback = "postgres://postgres:bullpane@127.0.0.1:5440/bullpane";
  if (explicit) {
    if (!(await reachable(explicit))) throw new Error(`BULLPANE_SMOKE_PG_URL is set but ${explicit} is unreachable`);
    return { url: explicit, stop: () => undefined };
  }
  if (await reachable(fallback)) return { url: fallback, stop: () => undefined };
  const name = `bullpane-smoke-pg-${process.pid}`;
  info(`no Postgres at ${fallback}: starting a throwaway container (${name})`);
  execFileSync("docker", ["run", "-d", "--rm", "--name", name, "--shm-size=512m", "-e", "POSTGRES_PASSWORD=bullpane", "-e", "POSTGRES_DB=bullpane", "-p", "127.0.0.1::5432", "postgres:16-alpine"], { stdio: "ignore" });
  const port = execFileSync("docker", ["port", name, "5432/tcp"]).toString().trim().split(":").pop();
  const url = `postgres://postgres:bullpane@127.0.0.1:${port}/bullpane`;
  for (let i = 0; i < 60 && !(await reachable(url)); i++) await sleep(500);
  return { url, stop: () => execFileSync("docker", ["rm", "-f", name], { stdio: "ignore" }) };
}

async function main(): Promise<number> {
  heading("Setup");
  const db = await postgres();
  const run = Math.random().toString(36).slice(2, 8);
  const schema = `smoke_${run}`;
  const uiSchema = `smoke_${run}_ui`;
  const freeSchema = `smoke_${run}_free`;
  info(`postgres ${db.url.replace(/:[^:@/]+@/, ":****@")} · schemas ${schema}, ${uiSchema}, ${freeSchema}`);

  // Always rebuilt: a stale apps/web/dist would make the browser test a test of yesterday's UI.
  if (!skip.has("ui") && process.env.SMOKE_NO_BUILD !== "1") {
    await check("build the web UI", () => {
      execSync("pnpm --filter @bullpane/web build", { cwd: REPO_ROOT, stdio: "ignore" });
    });
  }

  let server: RunningServer | null = null;
  const cleanups: (() => Promise<void> | void)[] = [];
  try {
    const seeded = await check("seed real BullMQ data (workers, flows, schedulers, a paused queue, a held job)", async () => {
      await resetSchema(db.url, schema);
      return seed(db.url, schema);
    });
    if (!seeded) throw new Abort("seed failed");
    cleanups.push(() => seeded.close());

    server = (await check("start the server (Pro edition, throwaway license)", () => startServer({ pro: true })))!;
    if (!server) throw new Abort("server did not start");
    const api = new Api(server.url);

    // 1. every feature over HTTP
    const cid = await runFunctional({ api, base: server.url, pro: true, pgUrl: db.url, schema, seeded });

    // 2. reads must not slow the workers, and must not lock
    if (!skip.has("interference")) await runInterference({ api, cid, pgUrl: db.url, schema, serverStartedAt: server.startedAt });
    await runCleanup(api, cid);
    await seeded.close();

    // 3. the browser journey, on fresh data
    if (!skip.has("ui")) {
      const uiSeed = await check("seed fresh data for the browser journey", async () => {
        await resetSchema(db.url, uiSchema);
        return seed(db.url, uiSchema);
      });
      if (uiSeed) {
        cleanups.push(() => uiSeed.close());
        await runUi({ base: server.url, api, pgUrl: db.url, schema: uiSchema, login: ADMIN });
      }
    }
    await server.stop();
    server = null;

    // 4. free edition: no login, every read and action, Pro routes locked
    if (!skip.has("free")) await runFree(db.url, freeSchema, cleanups);

    // 5. where customers run Postgres: poolers, TLS, a read-only role, MySQL app DB
    if (!skip.has("environments")) await runEnvironments();
  } catch (err) {
    if (!(err instanceof Abort)) throw err;
  } finally {
    for (const c of cleanups.reverse()) await Promise.resolve(c()).catch(() => undefined);
    if (server) {
      if (process.env.SMOKE_SERVER_LOG) console.log(server.log());
      await server.stop();
    }
    for (const s of [schema, uiSchema, freeSchema]) await dropSchema(db.url, s).catch(() => undefined);
    db.stop();
  }
  return summary();
}

async function runFree(pgUrl: string, schema: string, cleanups: (() => Promise<void> | void)[]): Promise<void> {
  heading("Free edition: no login, same Postgres features, Pro routes locked");
  const seeded = await check("seed", async () => {
    await resetSchema(pgUrl, schema);
    return seed(pgUrl, schema);
  });
  if (!seeded) return;
  cleanups.push(() => seeded.close());
  const server = await check("start the server (free edition)", () => startServer({ pro: false }));
  if (!server) return;
  const api = new Api(server.url);
  try {
    let cid = "";
    await check("create the Postgres connection with no login", async () => {
      cid = (await api.post<{ id: string }>("/connections", { name: "pg-free", kind: "postgres", url: pgUrl, prefix: schema })).id;
    });
    await check("read counts", async () => {
      const q = await api.get<{ counts: { waiting: number } }>(`/connections/${cid}/queues/orders`);
      assert(q.counts.waiting === SEED.ordersWaiting, `waiting ${q.counts.waiting}`);
    });
    await check("search", async () => {
      const r = await api.get<{ jobs: { id: string }[] }>(`/connections/${cid}/queues/orders/jobs/search?state=waiting&q=needle`);
      assert(r.jobs.length === 1, `${r.jobs.length} hits`);
    });
    await check("remove a job", async () => {
      const r = await api.get<{ jobs: { id: string }[] }>(`/connections/${cid}/queues/orders/jobs/search?state=waiting&q=needle`);
      await api.del(`/connections/${cid}/queues/orders/jobs/${r.jobs[0]!.id}`);
      await api.expect(404, "GET", `/connections/${cid}/queues/orders/jobs/${r.jobs[0]!.id}`);
    });
    await check("flow tree works in free (it is not a Pro feature)", () => api.get(`/connections/${cid}/queues/assemble/jobs/${seeded.flowRootId}/tree`));
    for (const route of [`/connections/${cid}/flows`, "/alerts", "/folders", "/audit"]) {
      await check(`Pro route ${route} answers 402 pro_required`, async () => {
        const body = (await api.expect(402, "GET", route)) as { error: string };
        assert(body.error === "pro_required", JSON.stringify(body));
      });
    }
  } finally {
    await server.stop();
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
