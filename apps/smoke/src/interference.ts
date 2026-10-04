/**
 * "Does looking at the queues slow the queues down?" — measured, not assumed.
 *
 * A steady BullMQ workload runs in its own process (worker-proc.ts) while the
 * dashboard is used at three intensities. For each phase we record the
 * workers' throughput and processing time, and a monitor connection samples
 * pg_stat_activity / pg_locks every 25 ms to prove the dashboard:
 *  - holds nothing but AccessShareLock on relations while reading (no row locks),
 *  - never blocks a worker and never waits on a lock itself,
 *  - is never `idle in transaction`,
 *  - stays inside its 4-connection read pool and its statement timeout.
 */
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import pg from "pg";
import type { JobsPage } from "@bullpane/shared";
import { Api, REPO_ROOT } from "./server.js";
import { assert, check, heading, info, percentile } from "./harness.js";

const PHASE_MS = Number(process.env.SMOKE_PHASE_MS ?? 15_000);
const WARMUP_MS = 2_000;
const DASHBOARD_APP = "bullpane-dashboard";

interface Sample {
  t: number;
  completed: number;
  p50: number | null;
  p95: number | null;
}

class Workload {
  private child: ChildProcess | null = null;
  readonly samples: Sample[] = [];

  start(url: string, schema: string): void {
    this.child = spawn(path.join(REPO_ROOT, "node_modules/.bin/tsx"), ["src/worker-proc.ts", url, schema, "throughput", "20"], {
      cwd: path.join(REPO_ROOT, "apps/smoke"),
      stdio: ["ignore", "pipe", "inherit"],
    });
    let buf = "";
    this.child.stdout?.on("data", (d: Buffer) => {
      buf += d.toString();
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        try {
          this.samples.push(JSON.parse(line) as Sample);
        } catch {
          /* not a sample */
        }
      }
    });
  }

  /** jobs/s and processing-time p95 between two instants, warm-up excluded */
  stats(from: number, to: number): { jobsPerSec: number; p95: number } {
    const s = this.samples.filter((x) => x.t > from + WARMUP_MS && x.t <= to);
    const jobsPerSec = s.reduce((a, b) => a + b.completed, 0) / Math.max(1, s.length);
    const p95 = percentile(s.map((x) => x.p95 ?? 0).filter((x) => x > 0), 50); // median of per-second p95s
    return { jobsPerSec, p95 };
  }

  async stop(): Promise<void> {
    this.child?.kill("SIGTERM");
    await sleep(500);
  }
}

interface LockReport {
  samples: number;
  maxDashboardConnections: number;
  maxDashboardQueryMs: number;
  /** distinct lock modes the dashboard held, as "locktype:mode" */
  modes: Set<string>;
  violations: string[];
  workersBlockedByDashboard: number;
  maxWorkerBlockedMs: number;
  /** what the dashboard sessions were doing the first time they exceeded the read pool */
  overPool: string[];
}

class LockMonitor {
  private client: pg.Client;
  private running = false;
  private loop: Promise<void> | null = null;
  report: LockReport = LockMonitor.empty();

  static empty(): LockReport {
    return { samples: 0, maxDashboardConnections: 0, maxDashboardQueryMs: 0, modes: new Set(), violations: [], workersBlockedByDashboard: 0, maxWorkerBlockedMs: 0, overPool: [] };
  }

  /**
   * `since`: only sessions opened after the server under test started are its
   * own. An older `bullpane-dashboard` session belongs to something else (another
   * dashboard, or a pooler that kept a server connection named after a client).
   */
  constructor(url: string, private readonly since: Date) {
    this.client = new pg.Client({ connectionString: url, application_name: "bullpane-smoke-monitor" });
  }

  async connect(): Promise<void> {
    await this.client.connect();
  }

  /** `reads`: during read-only phases any lock beyond AccessShareLock is a violation. */
  start(reads: boolean): void {
    this.report = LockMonitor.empty();
    this.running = true;
    this.loop = (async () => {
      while (this.running) {
        await this.sample(reads).catch((err) => this.report.violations.push(`monitor error: ${err instanceof Error ? err.message : err}`));
        await sleep(25);
      }
    })();
  }

  async stop(): Promise<LockReport> {
    this.running = false;
    await this.loop;
    return this.report;
  }

  private async sample(reads: boolean): Promise<void> {
    const r = this.report;
    r.samples += 1;
    const { rows: sessions } = await this.client.query<{
      pid: number;
      app: string;
      state: string | null;
      query: string | null;
      backend_start: Date;
      wait_event_type: string | null;
      running_ms: number | null;
      blocked_by: number[];
      waiting_ms: number | null;
    }>(`
      SELECT pid, application_name AS app, state, left(query, 80) AS query, backend_start, wait_event_type,
        CASE WHEN state = 'active' THEN extract(epoch FROM clock_timestamp() - query_start) * 1000 END AS running_ms,
        pg_blocking_pids(pid) AS blocked_by,
        CASE WHEN wait_event_type = 'Lock' THEN extract(epoch FROM clock_timestamp() - query_start) * 1000 END AS waiting_ms
      FROM pg_stat_activity
      WHERE datname = current_database() AND pid <> pg_backend_pid() AND backend_type = 'client backend'`);
    const dashboard = sessions.filter((s) => s.app === DASHBOARD_APP && s.backend_start >= this.since);
    const dashboardPids = new Set(dashboard.map((s) => s.pid));
    r.maxDashboardConnections = Math.max(r.maxDashboardConnections, dashboard.length);
    if (dashboard.length > 4 && r.overPool.length === 0) {
      r.overPool = dashboard.map((d) => `pid ${d.pid} ${d.state} since ${d.backend_start.toISOString().slice(11, 19)}: ${(d.query ?? "").replace(/\s+/g, " ")}`);
    }
    for (const s of dashboard) {
      if (s.running_ms !== null) r.maxDashboardQueryMs = Math.max(r.maxDashboardQueryMs, Number(s.running_ms));
      if (s.state === "idle in transaction" || s.state === "idle in transaction (aborted)") r.violations.push(`dashboard pid ${s.pid} idle in transaction`);
      if (reads && s.wait_event_type === "Lock") r.violations.push(`dashboard pid ${s.pid} waited on a lock while reading`);
    }
    for (const s of sessions) {
      if (dashboardPids.has(s.pid)) continue;
      if (s.blocked_by.some((p) => dashboardPids.has(p))) {
        r.workersBlockedByDashboard += 1;
        r.maxWorkerBlockedMs = Math.max(r.maxWorkerBlockedMs, Number(s.waiting_ms ?? 0));
        if (reads) r.violations.push(`worker pid ${s.pid} blocked by the dashboard (pids ${s.blocked_by.join(",")})`);
      }
    }
    if (dashboardPids.size === 0) return;
    const { rows: locks } = await this.client.query<{ pid: number; locktype: string; mode: string; relname: string | null; granted: boolean }>(
      `SELECT l.pid, l.locktype, l.mode, c.relname, l.granted
         FROM pg_locks l LEFT JOIN pg_class c ON c.oid = l.relation
        WHERE l.pid = ANY($1::int[])`,
      [[...dashboardPids]],
    );
    for (const l of locks) {
      r.modes.add(`${l.locktype}:${l.mode}`);
      if (!reads) continue;
      // A read transaction holds its own virtualxid (ExclusiveLock on itself, not a
      // data lock) and AccessShareLock on what it reads. Anything else means a write.
      const allowed = (l.locktype === "relation" && l.mode === "AccessShareLock") || l.locktype === "virtualxid";
      if (!allowed) r.violations.push(`dashboard pid ${l.pid} held ${l.locktype}:${l.mode}${l.relname ? ` on ${l.relname}` : ""}`);
    }
  }

  async end(): Promise<void> {
    await this.client.end();
  }
}

/** One simulated browser tab: what the UI polls, at the rate the UI polls it. */
async function realisticTab(api: Api, cid: string, until: number, latencies: Map<string, number[]>, i: number): Promise<void> {
  const timed = async (label: string, route: string) => {
    const t0 = performance.now();
    await api.get(route);
    const list = latencies.get(label) ?? [];
    list.push(performance.now() - t0);
    latencies.set(label, list);
  };
  await sleep((i * 500) % 5000); // tabs are not opened in the same millisecond
  while (Date.now() < until) {
    await Promise.all([
      timed("overview", `/connections/${cid}/overview`),
      timed("health", "/health/connections"),
      i % 2 === 0 ? timed("jobs page", `/connections/${cid}/queues/throughput/jobs?state=waiting&pageSize=25`) : Promise.resolve(),
      i % 3 === 0 ? timed("history page", `/connections/${cid}/queues/history/jobs?state=completed&pageSize=25`) : Promise.resolve(),
    ]);
    await sleep(5000);
  }
}

/** A client hammering the heaviest reads back to back, no think time. */
async function stressLoop(api: Api, cid: string, until: number, latencies: Map<string, number[]>, ids: string[]): Promise<void> {
  const reads: [string, () => string][] = [
    ["overview", () => `/connections/${cid}/overview`],
    ["queue list", () => `/connections/${cid}/queues`],
    ["jobs page (hot queue)", () => `/connections/${cid}/queues/throughput/jobs?state=waiting&pageSize=50`],
    ["history page 1", () => `/connections/${cid}/queues/history/jobs?state=completed&pageSize=50`],
    ["history page 200 (offset 10k)", () => `/connections/${cid}/queues/history/jobs?state=completed&pageSize=50&page=200`],
    ["search 1000 jobs", () => `/connections/${cid}/queues/history/jobs/search?state=completed&q=zzz-miss`],
    ["job detail", () => `/connections/${cid}/queues/history/jobs/${ids[Math.floor(Math.random() * ids.length)]}`],
    ["health", () => "/health/connections"],
  ];
  let k = Math.floor(Math.random() * reads.length);
  while (Date.now() < until) {
    const [label, route] = reads[k++ % reads.length]!;
    const t0 = performance.now();
    await api.get(route()).catch(() => undefined);
    const list = latencies.get(label) ?? [];
    list.push(performance.now() - t0);
    latencies.set(label, list);
  }
}

function printLatencies(latencies: Map<string, number[]>): void {
  for (const [label, xs] of latencies) {
    info(`${label.padEnd(30)} n=${String(xs.length).padStart(5)}  p50 ${percentile(xs, 50).toFixed(1).padStart(7)} ms  p95 ${percentile(xs, 95).toFixed(1).padStart(7)} ms`);
  }
}

function printLocks(r: LockReport): void {
  if (r.overPool.length) for (const line of r.overPool) info(`over the read pool → ${line}`);
  info(`lock samples ${r.samples} · dashboard connections ≤ ${r.maxDashboardConnections} · longest dashboard query ${r.maxDashboardQueryMs.toFixed(0)} ms`);
  info(`lock modes held by the dashboard: ${[...r.modes].sort().join(", ") || "none seen"}`);
}

export async function runInterference(opts: { api: Api; cid: string; pgUrl: string; schema: string; serverStartedAt: Date }): Promise<void> {
  const { api, cid, pgUrl, schema } = opts;
  heading("Non-interference: reading must not slow the workers, and must not lock");

  // A realistic history to read: 300k completed + 20k failed rows, vacuumed
  // like autovacuum would have done in production.
  const admin = new pg.Client({ connectionString: pgUrl });
  await admin.connect();
  await check("load 320k finished jobs of history (and VACUUM ANALYZE, as autovacuum would)", async () => {
    await admin.query(`SET search_path TO "${schema}"`);
    await admin.query(`
      INSERT INTO job (queue, id, seq, name, state, data, priority, added_at_ms, processed_at_ms, finished_at_ms, failed_reason)
      SELECT 'history', 'h' || g, nextval('job_seq'), 'archived',
        (CASE WHEN g % 16 = 0 THEN 'failed' ELSE 'completed' END)::job_state,
        jsonb_build_object('n', g, 'customer', 'c' || g, 'pad', repeat('x', 300)),
        0, 1700000000000 + g, 1700000000000 + g, 1700000000000 + g * 10,
        CASE WHEN g % 16 = 0 THEN 'boom ' || g END
      FROM generate_series(1, 320000) g`);
    await admin.query(`INSERT INTO meta (queue, field, value) VALUES ('history', 'version', 'bullmq:6.3.4') ON CONFLICT DO NOTHING`);
    await admin.query("VACUUM ANALYZE job");
  });
  const ids = Array.from({ length: 200 }, (_, i) => `h${(i + 1) * 1500}`);

  const monitor = new LockMonitor(pgUrl, opts.serverStartedAt);
  await monitor.connect();
  const workload = new Workload();
  workload.start(pgUrl, schema);
  await sleep(4000); // workers connected, backlog built

  const phase = async (name: string, reads: boolean, load: (until: number) => Promise<void>) => {
    const from = Date.now();
    monitor.start(reads);
    await load(from + PHASE_MS);
    const until = Math.max(Date.now(), from + PHASE_MS);
    await sleep(Math.max(0, until - Date.now()));
    const locks = await monitor.stop();
    return { name, ...workload.stats(from, Date.now()), locks };
  };

  const before = await phase("baseline (no dashboard)", true, async () => undefined);

  const realisticLat = new Map<string, number[]>();
  const realistic = await phase("10 open tabs polling like the UI", true, async (until) => {
    await Promise.all(Array.from({ length: 10 }, (_, i) => realisticTab(api, cid, until, realisticLat, i)));
  });
  const stressLat = new Map<string, number[]>();
  const stress = await phase("20 clients hammering heavy reads, no pause", true, async (until) => {
    await Promise.all(Array.from({ length: 20 }, () => stressLoop(api, cid, until, stressLat, ids)));
  });
  const writes = await phase("dashboard actions while workers run", false, async (until) => {
    // heavy writes, through the official bullmq API: retry 20k failed, then clean
    await api.post(`/connections/${cid}/queues/history/retry-all`, { state: "failed" });
    await api.post(`/connections/${cid}/queues/history/clean`, { state: "completed", grace: 0, limit: 20000 });
    const page = await api.get<JobsPage>(`/connections/${cid}/queues/history/jobs?state=waiting&pageSize=200`);
    await api.post(`/connections/${cid}/queues/history/jobs/bulk/remove`, { jobIds: page.jobs.map((j) => j.id) });
    await sleep(Math.max(0, until - Date.now()));
  });
  // A second baseline at the end: the machine's own drift between phases is the
  // noise floor every ratio below has to be read against.
  const after = await phase("baseline again (no dashboard)", true, async () => undefined);
  await workload.stop();
  await monitor.end();
  await admin.end();

  const baseline = { jobsPerSec: (before.jobsPerSec + after.jobsPerSec) / 2, p95: Math.max(before.p95, after.p95) };
  const noise = Math.abs(before.jobsPerSec - after.jobsPerSec) / baseline.jobsPerSec;
  info(`baseline: ${before.jobsPerSec.toFixed(0)} jobs/s before, ${after.jobsPerSec.toFixed(0)} after (machine noise ${(noise * 100).toFixed(0)}%), processing p95 ${baseline.p95} ms`);
  await check("baseline workload is running", () => assert(baseline.jobsPerSec > 50, `${baseline.jobsPerSec} jobs/s`));

  for (const p of [realistic, stress, writes]) {
    const ratio = p.jobsPerSec / baseline.jobsPerSec;
    info(`${p.name}: ${p.jobsPerSec.toFixed(0)} jobs/s (${(ratio * 100).toFixed(0)}% of baseline), processing p95 ${p.p95} ms (baseline ${baseline.p95} ms)`);
  }

  heading("Non-interference: realistic use (10 tabs)");
  printLatencies(realisticLat);
  printLocks(realistic.locks);
  // Against the slower of the two baselines: the machine's own drift between
  // them is not something the dashboard did.
  const floor = Math.min(before.jobsPerSec, after.jobsPerSec);
  await check("workers keep ≥ 90% of their throughput with 10 tabs open (vs the slower baseline)", () =>
    assert(realistic.jobsPerSec >= floor * 0.9, `${realistic.jobsPerSec.toFixed(0)} vs ${floor.toFixed(0)} jobs/s`),
  );
  await check("reads take no row locks, block no worker, never wait on a lock", () =>
    assert(realistic.locks.violations.length === 0, realistic.locks.violations.slice(0, 5).join("; ")),
  );
  await check("every page answers in < 500 ms (p95)", () => {
    for (const [label, xs] of realisticLat) assert(percentile(xs, 95) < 500, `${label} p95 ${percentile(xs, 95).toFixed(0)} ms`);
  });

  heading("Non-interference: stress (20 clients, no think time)");
  printLatencies(stressLat);
  printLocks(stress.locks);
  await check("reads under stress: no row locks, no blocked worker, no lock waits, no idle-in-transaction", () =>
    assert(stress.locks.violations.length === 0, stress.locks.violations.slice(0, 5).join("; ")),
  );
  await check("the dashboard never uses more than its 4 read connections", () =>
    assert(stress.locks.maxDashboardConnections <= 4, `${stress.locks.maxDashboardConnections} connections`),
  );
  await check("no dashboard statement runs anywhere near the 10 s statement timeout", () =>
    assert(stress.locks.maxDashboardQueryMs < 2000, `${stress.locks.maxDashboardQueryMs.toFixed(0)} ms`),
  );
  // ~800 requests/s against one Postgres with 4 cores, workers on the same box:
  // far past any real use. Reported, and held to a floor, not to "no impact".
  await check("workers keep ≥ 40% of their throughput even under a read storm on the same 4-core database", () =>
    assert(stress.jobsPerSec >= baseline.jobsPerSec * 0.4, `${stress.jobsPerSec.toFixed(0)} vs ${baseline.jobsPerSec.toFixed(0)} jobs/s`),
  );

  heading("Non-interference: dashboard writes while workers run");
  printLocks(writes.locks);
  info(`worker samples blocked by a dashboard write: ${writes.locks.workersBlockedByDashboard}, longest ${writes.locks.maxWorkerBlockedMs.toFixed(0)} ms`);
  await check("a heavy action (retry 20k, clean 20k) never blocks a worker for more than 1 s", () =>
    assert(writes.locks.maxWorkerBlockedMs < 1000, `${writes.locks.maxWorkerBlockedMs.toFixed(0)} ms`),
  );
  await check("workers keep ≥ 50% of their throughput during heavy actions", () =>
    assert(writes.jobsPerSec >= baseline.jobsPerSec * 0.5, `${writes.jobsPerSec.toFixed(0)} vs ${baseline.jobsPerSec.toFixed(0)} jobs/s`),
  );
  await check("no idle-in-transaction dashboard session during writes", () =>
    assert(!writes.locks.violations.some((v) => v.includes("idle in transaction")), writes.locks.violations.join("; ")),
  );
}
