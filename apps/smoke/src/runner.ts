/**
 * The smoke, for one backend. postgres.ts and redis.ts only provide the
 * database; everything a person does with Bullpane runs here, identically:
 *   1. every feature over HTTP (Pro edition, so Pro features too)
 *   2. backend extras (Postgres: load and locks) via `afterFunctional`
 *   3. the browser journey, on fresh data
 *   4. the free edition: no login, the same reads and actions, Pro routes locked
 *   5. backend extras that need no running server (Postgres: environments)
 */
import { execSync } from "node:child_process";
import { Abort, assert, check, heading, summary } from "./harness.js";
import { runCleanup, runFunctional } from "./functional.js";
import { dispose, prepare, seed, SEED, type Seeded, type Target } from "./seed.js";
import { Api, REPO_ROOT, startServer, type RunningServer } from "./server.js";
import { runUi } from "./ui.js";

export const skip = new Set((process.env.SMOKE_SKIP ?? "").split(",").map((s) => s.trim()).filter(Boolean));
const ADMIN = { email: "admin@smoke.test", password: "smoke-password-1" };

export interface SuiteOptions {
  /** where the queues live; each section gets its own namespace derived from it */
  base: { kind: Target["kind"]; url: string };
  /** a short run id, part of every namespace */
  run: string;
  afterFunctional?: (ctx: { api: Api; cid: string; target: Target; server: RunningServer }) => Promise<void>;
  extras?: () => Promise<void>;
}

const nsFor = (kind: Target["kind"], run: string, section: string) => (kind === "postgres" ? `smoke_${run}_${section}` : `smoke-${run}-${section}`);

export async function runSuite(opts: SuiteOptions): Promise<number> {
  const target = (section: string): Target => ({ kind: opts.base.kind, url: opts.base.url, ns: nsFor(opts.base.kind, opts.run, section) });
  const used: Target[] = [];
  const fresh = async (section: string, what: string): Promise<{ t: Target; seeded: Seeded } | undefined> => {
    const t = target(section);
    used.push(t);
    const seeded = await check(what, async () => {
      await prepare(t);
      return seed(t);
    });
    return seeded ? { t, seeded } : undefined;
  };

  // Always rebuilt: a stale apps/web/dist would make the browser test a test of yesterday's UI.
  if (!skip.has("ui") && process.env.SMOKE_NO_BUILD !== "1") {
    await check("build the web UI", () => {
      execSync("pnpm --filter @bullpane/web build", { cwd: REPO_ROOT, stdio: "ignore" });
    });
  }

  let server: RunningServer | null = null;
  const cleanups: (() => Promise<void> | void)[] = [];
  try {
    const main = await fresh("main", "seed real BullMQ data (workers, flows, schedulers, a paused queue, a held job)");
    if (!main) throw new Abort("seed failed");
    cleanups.push(() => main.seeded.close());

    server = (await check("start the server (Pro edition, throwaway license)", () => startServer({ pro: true })))!;
    if (!server) throw new Abort("server did not start");
    const api = new Api(server.url);

    const cid = await runFunctional({ api, base: server.url, pro: true, target: main.t, seeded: main.seeded });
    if (opts.afterFunctional) await opts.afterFunctional({ api, cid, target: main.t, server });
    await runCleanup(api, cid);
    await main.seeded.close();

    if (!skip.has("ui")) {
      const ui = await fresh("ui", "seed fresh data for the browser journey");
      if (ui) {
        cleanups.push(() => ui.seeded.close());
        await runUi({ base: server.url, api, target: ui.t, login: ADMIN });
      }
    }
    await server.stop();
    server = null;

    if (!skip.has("free")) {
      const free = await fresh("free", "seed data for the free edition");
      if (free) {
        cleanups.push(() => free.seeded.close());
        await runFree(free.t, free.seeded);
      }
    }

    if (opts.extras) await opts.extras();
  } catch (err) {
    if (!(err instanceof Abort)) throw err;
  } finally {
    for (const c of cleanups.reverse()) await Promise.resolve(c()).catch(() => undefined);
    if (server) {
      if (process.env.SMOKE_SERVER_LOG) console.log(server.log());
      await server.stop();
    }
    for (const t of used) await dispose(t).catch(() => undefined);
  }
  return summary();
}

async function runFree(t: Target, seeded: Seeded): Promise<void> {
  heading(`Free edition (${t.kind}): no login, same features, Pro routes locked`);
  const server = await check("start the server (free edition)", () => startServer({ pro: false }));
  if (!server) return;
  const api = new Api(server.url);
  try {
    let cid = "";
    await check(`create the ${t.kind} connection with no login`, async () => {
      cid = (await api.post<{ id: string }>("/connections", { name: `${t.kind}-free`, kind: t.kind, url: t.url, prefix: t.ns })).id;
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

