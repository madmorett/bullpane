/**
 * Simulated dashboard users hitting the Bullpane HTTP API the way browsers do.
 *
 *   MODE=idle       1 user parked on Overview (queues every 5 s, health every 3 s)
 *   MODE=realistic  5 users: overview, two queue pages polling (3 s), a job page, alerts/health
 *   MODE=hostile    CLIENTS parallel loops with no pause on the most expensive reads:
 *                   200 × 1 MB jobs per page, substring search scanning 1000 hashes,
 *                   deep pages of a 1M zset, forced discovery (refresh=1)
 *
 * Env: BASE, COOKIE (bullpane_session), CID, MODE, DURATION (s), CLIENTS. Prints a
 * per-endpoint latency table (JSON) when done.
 */
import { QUEUES, percentile, sleep } from "./common.js";

const BASE = process.env.BASE ?? "http://localhost:3100";
const COOKIE = process.env.COOKIE ?? "";
const CID = process.env.CID ?? "";
const MODE = process.env.MODE ?? "realistic";
const DURATION = Number(process.env.DURATION ?? 60) * 1000;
const CLIENTS = Number(process.env.CLIENTS ?? 20);
const deadline = Date.now() + DURATION;

const stats = new Map<string, { ms: number[]; errors: number; statuses: Record<string, number> }>();
async function hit(label: string, path: string): Promise<unknown> {
  const s = stats.get(label) ?? { ms: [], errors: 0, statuses: {} };
  stats.set(label, s);
  const t = performance.now();
  try {
    const res = await fetch(BASE + path, { headers: { cookie: `bullpane_session=${COOKIE}` } });
    const body = await res.text();
    s.ms.push(performance.now() - t);
    s.statuses[res.status] = (s.statuses[res.status] ?? 0) + 1;
    if (!res.ok) s.errors++;
    return res.ok ? JSON.parse(body) : null;
  } catch {
    s.ms.push(performance.now() - t); s.errors++; return null;
  }
}
const q = (queue: string) => `/api/connections/${CID}/queues/${encodeURIComponent(queue)}`;
async function loop(fn: () => Promise<void>, everyMs: number): Promise<void> {
  while (Date.now() < deadline) { const t = Date.now(); await fn(); const left = everyMs - (Date.now() - t); if (left > 0) await sleep(left); }
}

const overview = () => loop(async () => { await hit("overview:queues", `/api/connections/${CID}/queues`); }, 5000);
const health = () => loop(async () => { await hit("health", `/api/health/connections`); }, 3000);
const queuePage = (queue: string, state: string, pageSize = 25) => loop(async () => {
  await Promise.all([hit(`queue:${queue}:summary`, q(queue)), hit(`queue:${queue}:jobs(${state},${pageSize})`, `${q(queue)}/jobs?state=${state}&page=1&pageSize=${pageSize}`)]);
}, 3000);
const setupPoll = (queue: string) => loop(async () => { await hit(`queue:${queue}:setup`, `${q(queue)}/setup`); }, 10_000);
const jobPage = (queue: string, state: string) => loop(async () => {
  const page = (await hit(`job:${queue}:list`, `${q(queue)}/jobs?state=${state}&page=1&pageSize=1`)) as { jobs?: { id: string }[] } | null;
  const id = page?.jobs?.[0]?.id; if (id) await hit(`job:${queue}:detail`, `${q(queue)}/jobs/${id}`);
}, 5000);
const alerts = () => loop(async () => { await hit("alerts", `/api/alerts`); }, 5000);

async function hostileClient(i: number): Promise<void> {
  while (Date.now() < deadline) {
    switch (i % 5) {
      case 0: await hit("hostile:fat page200", `${q(QUEUES.fat)}/jobs?state=waiting&page=1&pageSize=200`); break;
      case 1: { // search streams: follow the cursor a few times like the UI does
        let cursor: string | null = null;
        for (let k = 0; k < 5 && Date.now() < deadline; k++) {
          const r = (await hit("hostile:search backlog", `${q(QUEUES.backlog)}/jobs/search?state=waiting&q=zz-not-there&limit=50${cursor ? `&cursor=${cursor}` : ""}`)) as { nextCursor: string | null } | null;
          cursor = r?.nextCursor ?? null; if (!cursor) break;
        }
        break;
      }
      case 2: await hit("hostile:search fat", `${q(QUEUES.fat)}/jobs/search?state=waiting&q=zz-not-there&limit=50`); break;
      case 3: await hit("hostile:archive deep page", `${q(QUEUES.archive)}/jobs?state=completed&page=2500&pageSize=200`); break;
      case 4: await hit("hostile:discovery refresh", `/api/connections/${CID}/queues?refresh=1`); break;
    }
  }
}

async function main(): Promise<void> {
  const tasks: Promise<void>[] = [];
  if (MODE === "idle") tasks.push(overview(), health());
  if (MODE === "realistic") tasks.push(overview(), health(), alerts(), queuePage(QUEUES.backlog, "waiting"), setupPoll(QUEUES.backlog), queuePage(QUEUES.archive, "failed", 50), queuePage(QUEUES.fat, "waiting"), jobPage(QUEUES.archive, "failed"), jobPage(QUEUES.fat, "waiting"), overview(), health());
  if (MODE === "hostile") for (let i = 0; i < CLIENTS; i++) tasks.push(hostileClient(i));
  await Promise.all(tasks);
  const table = [...stats.entries()].map(([label, s]) => { const ms = s.ms.sort((a, b) => a - b); return { label, n: ms.length, p50: +percentile(ms, 50).toFixed(0), p95: +percentile(ms, 95).toFixed(0), max: +(ms[ms.length - 1] ?? 0).toFixed(0), errors: s.errors, statuses: s.statuses }; });
  console.log(JSON.stringify({ mode: MODE, durationS: DURATION / 1000, endpoints: table }, null, 1));
}
void main();
