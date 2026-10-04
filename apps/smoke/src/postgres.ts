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
import { execFileSync } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import pg from "pg";
import { heading, info } from "./harness.js";
import { runInterference } from "./interference.js";
import { runSuite, skip } from "./runner.js";
import { runEnvironments } from "./environments.js";

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
  info(`postgres ${db.url.replace(/:[^:@/]+@/, ":****@")} · schemas smoke_${run}_*`);
  try {
    return await runSuite({
      base: { kind: "postgres", url: db.url },
      run,
      // reads must not slow the workers, and must not lock
      afterFunctional: skip.has("interference")
        ? undefined
        : ({ api, cid, target, server }) => runInterference({ api, cid, pgUrl: target.url, schema: target.ns, serverStartedAt: server.startedAt }),
      // where customers run Postgres: poolers, TLS, a read-only role, MySQL app DB
      extras: skip.has("environments") ? undefined : runEnvironments,
    });
  } finally {
    db.stop();
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
