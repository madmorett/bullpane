/**
 * Every feature, through the HTTP API, the way the browser uses it.
 * Each check asserts on what came back AND, for writes, on the effect.
 */
import type {
  Alert,
  AlertEvent,
  AttentionSnapshot,
  AuditPage,
  ConnectionHealth,
  ConnectionSchedulersPage,
  DiscoveryStatus,
  FlowGraph,
  Folder,
  GroupsPage,
  JobDetail,
  JobSearchResult,
  JobsPage,
  JobState,
  JobTree,
  QueueSetup,
  QueueSummary,
  RedisConnection,
  SchedulersPage,
  ServerInfo,
} from "@bullpane/shared";
import { Api } from "./server.js";

interface PingResult {
  ok: boolean;
  latencyMs: number;
  redisVersion: string | null;
  error: string | null;
}
import { Abort, assert, check, eq, heading, info, waitFor } from "./harness.js";
import { SEED, type Seeded, type Target } from "./seed.js";

interface Ctx {
  api: Api;
  base: string;
  pro: boolean;
  target: Target;
  seeded: Seeded;
}

type Overview = { info: ServerInfo; queues: QueueSummary[]; discovery: DiscoveryStatus; hiddenCount: number };

const ADMIN = { email: "admin@smoke.test", name: "Smoke Admin", password: "smoke-password-1" };

export async function runFunctional(ctx: Ctx): Promise<string> {
  const { api, pro } = ctx;
  let cid = "";
  const C = () => `/connections/${cid}`;
  const Q = (queue: string) => `${C()}/queues/${encodeURIComponent(queue)}`;
  const jobs = (queue: string, state: JobState, extra = "") => api.get<JobsPage>(`${Q(queue)}/jobs?state=${state}&pageSize=200${extra}`);

  // ---------------------------------------------------------------------------
  heading(`Session (${pro ? "Pro edition: first-run setup + login" : "free edition: no login"})`);
  if (pro) {
    await check("first-run setup creates the admin", async () => {
      await api.post("/setup", ADMIN);
      const me = await api.get<{ user: { role: string } }>("/auth/me");
      eq(me.user.role, "admin", "role");
    });
    await check("edition reports Pro", async () => {
      const ed = await api.get<{ tier: string; features: Record<string, boolean> }>("/edition");
      eq(ed.tier, "pro", "tier");
      assert(Object.values(ed.features).every(Boolean), `locked features: ${JSON.stringify(ed.features)}`);
    });
  } else {
    await check("API is open without a login", () => api.get("/connections"));
  }

  // ---------------------------------------------------------------------------
  const t = ctx.target;
  const pg = t.kind === "postgres";
  const label = pg ? "Postgres" : "Redis";
  heading(`Create a ${pg ? "PostgreSQL" : "Redis"} connection`);
  const goodUrl = t.url;
  const body = (extra: Record<string, unknown> = {}) => ({ kind: t.kind, url: goodUrl, prefix: t.ns, ...extra });
  if (pg) {
    const badUrl = (() => {
      const u = new URL(t.url);
      u.password = "definitely-wrong";
      return u.toString();
    })();
    await check("test connection: wrong password fails with Postgres' own message", async () => {
      const ping = await api.post<PingResult>("/connections/test", body({ url: badUrl }));
      assert(!ping.ok, "ping should fail");
      assert(/password authentication failed/.test(ping.error ?? ""), `unexpected error: ${ping.error}`);
    });
    await check("test connection: wrong schema says postgres_schema_missing", async () => {
      const ping = await api.post<PingResult>("/connections/test", body({ prefix: "no_such_schema" }));
      assert(!ping.ok && /postgres_schema_missing/.test(ping.error ?? ""), `unexpected: ${JSON.stringify(ping)}`);
    });
    await check("a redis:// URL on a postgres connection is refused (400)", () =>
      api.expect(400, "POST", "/connections", { name: "bad", kind: "postgres", url: "redis://localhost:6379" }),
    );
    await check("a schema name that is not an identifier is refused (400)", () =>
      api.expect(400, "POST", "/connections", { name: "bad", ...body({ prefix: "x; drop table job" }) }),
    );
  } else {
    await check("test connection: an unreachable Redis fails fast with the reason", async () => {
      const u = new URL(t.url);
      u.port = "1";
      const t0 = Date.now();
      const ping = await api.post<PingResult>("/connections/test", body({ url: u.toString() }));
      assert(!ping.ok && /ECONNREFUSED|unavailable|connect/i.test(ping.error ?? ""), `unexpected: ${JSON.stringify(ping)}`);
      assert(Date.now() - t0 < 8000, "took longer than the connect timeout");
    });
    await check("a postgres:// URL on a redis connection is refused (400)", () =>
      api.expect(400, "POST", "/connections", { name: "bad", kind: "redis", url: "postgres://u:p@localhost/db" }),
    );
    await check("a connection without kind is a Redis connection (what 0.5.x clients send)", async () => {
      const ping = await api.post<PingResult>("/connections/test", { url: goodUrl, prefix: t.ns });
      assert(ping.ok, JSON.stringify(ping));
    });
  }
  await check("test connection: the right one answers with the server version", async () => {
    const ping = await api.post<PingResult>("/connections/test", body());
    assert(ping.ok && /^\d+/.test(ping.redisVersion ?? ""), JSON.stringify(ping));
  });
  const created = await check("create the connection", async () => {
    const c = await api.post<RedisConnection>("/connections", { name: `${t.kind}-smoke`, ...body() });
    eq(c.kind, t.kind, "kind");
    eq(c.prefix, t.ns, "namespace");
    assert(c.status?.ok, `status not ok: ${JSON.stringify(c.status)}`);
    if (new URL(goodUrl).password) eq(new URL(c.url).password, "****", "password in the returned URL");
    return c;
  });
  if (!created) throw new Abort("cannot continue without a connection");
  cid = created.id;
  await check(`the connection is listed with kind ${t.kind}`, async () => {
    const list = await api.get<RedisConnection[]>("/connections");
    const c = list.find((x) => x.id === cid);
    assert(c && c.kind === t.kind, JSON.stringify(c));
  });

  // ---------------------------------------------------------------------------
  heading("Read: overview, queues, counts");
  const overview = await check(`connection overview: ${label} server info, discovery complete`, async () => {
    const o = await api.get<Overview>(`${C()}/overview?refresh=1`);
    if (pg) assert(o.info.backend === "postgres", `backend ${JSON.stringify(o.info).slice(0, 100)}`);
    else assert(o.info.backend !== "postgres" && /^\d/.test(o.info.redisVersion), `info ${JSON.stringify(o.info).slice(0, 100)}`);
    assert(o.discovery.complete, "discovery incomplete");
    return o;
  });
  await check("every queue is discovered, including flow-only ones (no meta)", async () => {
    const names = (overview?.queues ?? []).map((q) => q.name).sort();
    for (const n of ["assemble", "emails", "frozen", "orders", "parts", "reports", "stuck"]) assert(names.includes(n), `missing ${n} in ${names}`);
  });
  await check("counts match what was seeded", async () => {
    const byName = Object.fromEntries((overview?.queues ?? []).map((q) => [q.name, q]));
    eq(byName.orders?.counts.waiting, SEED.ordersWaiting, "orders waiting");
    eq(byName.orders?.counts.delayed, SEED.ordersDelayed, "orders delayed");
    eq(byName.orders?.counts.prioritized, SEED.ordersPrioritized, "orders prioritized");
    eq(byName.emails?.counts.completed, SEED.emails - SEED.emailsFailed, "emails completed");
    eq(byName.emails?.counts.failed, SEED.emailsFailed, "emails failed");
    eq(byName.stuck?.counts.active, 1, "stuck active");
    eq(byName.assemble?.counts["waiting-children"], 1, "assemble waiting-children");
    eq(byName.reports?.schedulersCount, 2, "reports schedulers");
  });
  await check("success rate comes from BullMQ's metrics", async () => {
    const emails = await api.get<QueueSummary>(Q("emails"));
    eq(emails.rates.source, "metrics", "source");
    eq(emails.rates.successPct, Math.round(((SEED.emails - SEED.emailsFailed) / SEED.emails) * 1000) / 10, "successPct");
    assert(emails.metrics, "metrics missing on the queue summary");
  });
  await check("a paused queue: flagged paused, its jobs shown as waiting", async () => {
    const frozen = await api.get<QueueSummary>(Q("frozen"));
    assert(frozen.isPaused, "not paused");
    eq(frozen.counts.waiting, SEED.pausedWaiting, "waiting");
    eq(frozen.counts.paused, 0, "paused bucket");
  });
  await check("queue setup: metrics on, connected worker visible", async () => {
    const setup = await api.get<QueueSetup>(`${Q("emails")}/setup`);
    assert(setup.metricsEnabled, "metrics not enabled");
    const stuck = await api.get<QueueSetup>(`${Q("stuck")}/setup`);
    eq(stuck.workers?.names, ["holder"], "workers");
  });
  await check("Pro groups panel is empty (open-source BullMQ, no groups)", async () => {
    const g = await api.get<GroupsPage>(`${Q("orders")}/groups`);
    eq(g.total, 0, "groups");
  });

  // ---------------------------------------------------------------------------
  heading("Read: jobs in every state");
  for (const [state, queue, expected] of [
    ["waiting", "orders", SEED.ordersWaiting],
    ["delayed", "orders", SEED.ordersDelayed],
    ["prioritized", "orders", SEED.ordersPrioritized],
    ["completed", "emails", SEED.emails - SEED.emailsFailed],
    ["failed", "emails", SEED.emailsFailed],
    ["active", "stuck", 1],
    ["waiting-children", "assemble", 1],
    ["paused", "frozen", 0],
  ] as const) {
    await check(`${queue} / ${state}: ${expected} jobs, each reporting that state`, async () => {
      const page = await jobs(queue, state);
      eq(page.total, expected, "total");
      eq(page.jobs.length, expected, "rows");
      for (const j of page.jobs) eq(j.state, state, `job ${j.id} state`);
    });
  }
  await check("pagination: page 2 of 25 continues page 1 without overlap", async () => {
    const p1 = await api.get<JobsPage>(`${Q("orders")}/jobs?state=waiting&pageSize=25&page=1`);
    const p2 = await api.get<JobsPage>(`${Q("orders")}/jobs?state=waiting&pageSize=25&page=2`);
    const ids = new Set([...p1.jobs, ...p2.jobs].map((j) => j.id));
    eq(ids.size, 50, "distinct ids across two pages");
  });
  await check("order: newest first by default, oldest first with order=asc", async () => {
    const desc = await api.get<JobsPage>(`${Q("orders")}/jobs?state=waiting&pageSize=1`);
    const asc = await api.get<JobsPage>(`${Q("orders")}/jobs?state=waiting&pageSize=1&order=asc`);
    eq(desc.jobs[0]?.name, "big", "newest");
    // jsonb renders `"n": 0`, a Redis hash keeps the producer's `"n":0`
    assert(/"n": ?0[,}]/.test(asc.jobs[0]?.dataPreview ?? ""), `oldest: ${asc.jobs[0]?.dataPreview}`);
  });
  await check("a 60 KB payload is not copied into the list: truncated, size reported", async () => {
    const page = await api.get<JobsPage>(`${Q("orders")}/jobs?state=waiting&pageSize=1`);
    const big = page.jobs[0]!;
    assert(big.dataTruncated && big.dataPreview.length <= 2048, `preview ${big.dataPreview.length} bytes`);
    assert((big.dataBytes ?? 0) > 1000, `dataBytes ${big.dataBytes}`);
  });
  await check("delayed jobs carry their due time", async () => {
    const page = await jobs("orders", "delayed");
    for (const j of page.jobs) assert((j.delayedUntil ?? 0) > Date.now() + 3_000_000, `delayedUntil ${j.delayedUntil}`);
  });

  // ---------------------------------------------------------------------------
  heading("Search jobs");
  const search = (queue: string, state: JobState, q: string, extra = "") =>
    api.get<JobSearchResult>(`${Q(queue)}/jobs/search?state=${state}&q=${encodeURIComponent(q)}${extra}`);
  await check("finds a value inside the payload", async () => {
    const r = await search("orders", "waiting", "needle-xyz");
    eq(r.jobs.length, 1, "hits");
    assert(r.jobs[0]!.dataPreview.includes("needle-xyz"), "wrong job");
  });
  await check("is case-insensitive", async () => eq((await search("orders", "waiting", "NEEDLE-XYZ")).jobs.length, 1, "hits"));
  await check("finds the failure reason", async () => eq((await search("emails", "failed", "smtp down")).jobs.length, SEED.emailsFailed, "hits"));
  await check("finds by job name", async () => eq((await search("orders", "prioritized", "vip")).jobs.length, SEED.ordersPrioritized, "hits"));
  await check("a miss returns nothing and no cursor", async () => {
    const r = await search("orders", "waiting", "zzz-not-there");
    eq(r.jobs.length, 0, "hits");
    eq(r.nextCursor, null, "cursor");
  });
  await check("% and _ match themselves, not everything", async () => {
    eq((await search("orders", "waiting", "%")).jobs.length, 0, "% hits");
    eq((await search("orders", "waiting", "_")).jobs.length, 0, "_ hits");
  });
  await check("cursor: a limited search resumes where it stopped", async () => {
    const first = await search("orders", "waiting", "customer", "&limit=10");
    eq(first.jobs.length, 10, "first page");
    assert(first.nextCursor, "no cursor");
    let all = first.jobs.map((j) => j.id);
    let cursor: string | null = first.nextCursor;
    while (cursor) {
      const next: JobSearchResult = await search("orders", "waiting", "customer", `&limit=10&cursor=${cursor}`);
      all = all.concat(next.jobs.map((j) => j.id));
      cursor = next.nextCursor;
    }
    eq(new Set(all).size, 61, "distinct hits across pages (60 orders + needle)");
  });

  // ---------------------------------------------------------------------------
  heading("Job detail, logs, flow tree");
  const failed = await jobs("emails", "failed");
  const completed = await jobs("emails", "completed");
  await check("completed job: data, return value, progress, logs", async () => {
    const d = await api.get<JobDetail>(`${Q("emails")}/jobs/${completed.jobs[0]!.id}`);
    eq(d.state, "completed", "state");
    eq(d.returnvalue, { sent: true }, "returnvalue");
    eq(d.progress, 50, "progress");
    eq(d.logsCount, 1, "logsCount");
    assert(d.logs[0]?.startsWith("sending"), `logs ${d.logs}`);
    eq(d.attempts, 1, "attempts");
  });
  await check("failed job: reason and stack trace", async () => {
    const d = await api.get<JobDetail>(`${Q("emails")}/jobs/${failed.jobs[0]!.id}`);
    eq(d.failedReason, "smtp down", "failedReason");
    assert(d.stacktrace.length > 0, "no stacktrace");
  });
  await check("logs endpoint pages the log lines", async () => {
    const l = await api.get<{ logs: string[]; count: number }>(`${Q("emails")}/jobs/${completed.jobs[0]!.id}/logs?start=0&end=-1`);
    eq(l.count, 1, "count");
  });
  await check("an unknown job is a 404", () => api.expect(404, "GET", `${Q("emails")}/jobs/does-not-exist`));
  await check("flow tree from the root: 5 jobs, parent waiting on 3 children", async () => {
    const t = await api.get<JobTree>(`${Q("assemble")}/jobs/${ctx.seeded.flowRootId}/tree`);
    eq(t.nodes.length, 5, "nodes");
    const root = t.nodes.find((n) => n.key === t.rootKey)!;
    eq(root.dependencies, { processed: 0, unprocessed: 3 }, "root dependencies");
  });
  await check("flow tree from a grandchild climbs to the same root", async () => {
    const parts = await jobs("parts", "waiting");
    const piston = parts.jobs.find((j) => j.name === "piston");
    assert(piston, "piston not found");
    const t = await api.get<JobTree>(`${Q("parts")}/jobs/${piston.id}/tree`);
    eq(t.climbedLevels, 2, "climbedLevels");
    eq(t.nodes.length, 5, "nodes");
  });

  // ---------------------------------------------------------------------------
  heading("Job schedulers");
  await check("queue schedulers: cron and every, with next run and template", async () => {
    const s = await api.get<SchedulersPage>(`${Q("reports")}/schedulers`);
    eq(s.total, 2, "total");
    const nightly = s.schedulers.find((x) => x.key === "nightly");
    assert(nightly?.pattern === "0 3 * * *" && (nightly.next ?? 0) > Date.now(), JSON.stringify(nightly));
    assert(nightly.template?.data?.includes("nightly"), "template data");
    eq(s.schedulers.find((x) => x.key === "hourly")?.every, 3_600_000, "every");
  });
  await check("connection-wide schedulers page lists both", async () => {
    const s = await api.get<ConnectionSchedulersPage>(`${C()}/schedulers`);
    eq(s.total, 2, "total");
    eq(s.failed, [], "failed queues");
  });
  await check("remove a scheduler", async () => {
    await api.del(`${Q("reports")}/schedulers/hourly`);
    eq((await api.get<SchedulersPage>(`${Q("reports")}/schedulers`)).total, 1, "after remove");
  });

  // ---------------------------------------------------------------------------
  heading("Write: job actions (through the official bullmq API)");
  const added = await check("add a job", async () => {
    const r = await api.post<{ id: string }>(`${Q("orders")}/jobs`, { name: "manual", data: { from: "smoke" } });
    const d = await api.get<JobDetail>(`${Q("orders")}/jobs/${r.id}`);
    eq(d.state, "waiting", "state");
    eq(d.data, { from: "smoke" }, "data");
    return r.id;
  });
  await check("remove a job", async () => {
    await api.del(`${Q("orders")}/jobs/${added}`);
    await api.expect(404, "GET", `${Q("orders")}/jobs/${added}`);
  });
  await check("promote a delayed job", async () => {
    const r = await api.post<{ id: string }>(`${Q("orders")}/jobs`, { name: "later", data: {}, opts: { delay: 600_000 } });
    eq((await api.get<JobDetail>(`${Q("orders")}/jobs/${r.id}`)).state, "delayed", "before");
    await api.post(`${Q("orders")}/jobs/${r.id}/promote`, {});
    eq((await api.get<JobDetail>(`${Q("orders")}/jobs/${r.id}`)).state, "waiting", "after");
    await api.del(`${Q("orders")}/jobs/${r.id}`);
  });
  await check("retry a failed job", async () => {
    const id = failed.jobs[0]!.id;
    await api.post(`${Q("emails")}/jobs/${id}/retry`, {});
    eq((await api.get<JobDetail>(`${Q("emails")}/jobs/${id}`)).state, "waiting", "after retry");
  });
  await check("retrying a job that is not finished is a 409", async () => {
    const waiting = await api.get<JobsPage>(`${Q("orders")}/jobs?state=waiting&pageSize=1`);
    await api.expect(409, "POST", `${Q("orders")}/jobs/${waiting.jobs[0]!.id}/retry`, {});
  });
  await check("bulk remove: partial result names the ids that failed", async () => {
    const page = await api.get<JobsPage>(`${Q("orders")}/jobs?state=waiting&pageSize=3&order=asc`);
    const ids = page.jobs.map((j) => j.id);
    const r = await api.post<{ ok: string[]; failed: { jobId: string }[] }>(`${Q("orders")}/jobs/bulk/remove`, { jobIds: [...ids, "ghost-1"] });
    eq(r.ok.sort(), ids.sort(), "ok");
    eq(r.failed.map((f) => f.jobId), ["ghost-1"], "failed");
    for (const id of ids) await api.expect(404, "GET", `${Q("orders")}/jobs/${id}`);
  });
  await check("bulk promote delayed jobs", async () => {
    const page = await jobs("orders", "delayed");
    const r = await api.post<{ ok: string[] }>(`${Q("orders")}/jobs/bulk/promote`, { jobIds: page.jobs.map((j) => j.id) });
    eq(r.ok.length, SEED.ordersDelayed, "promoted");
    eq((await jobs("orders", "delayed")).total, 0, "delayed left");
  });
  await check("bulk retry failed jobs", async () => {
    const page = await jobs("emails", "failed");
    const r = await api.post<{ ok: string[] }>(`${Q("emails")}/jobs/bulk/retry`, { jobIds: page.jobs.map((j) => j.id) });
    eq(r.ok.length, page.total, "retried");
    eq((await jobs("emails", "failed")).total, 0, "failed left");
  });
  await check("discard: an active job held by a live worker goes to failed, no retry", async () => {
    await api.post(`${Q("stuck")}/jobs/${ctx.seeded.stuckJobId}/discard`, {});
    const d = await api.get<JobDetail>(`${Q("stuck")}/jobs/${ctx.seeded.stuckJobId}`);
    eq(d.state, "failed", "state");
    eq(d.failedReason, "Discarded from Bullpane", "reason");
  });

  // ---------------------------------------------------------------------------
  heading("Write: queue actions");
  await check("pause, then resume", async () => {
    await api.post(`${Q("orders")}/pause`, { reason: "smoke" });
    assert((await api.get<QueueSummary>(Q("orders"))).isPaused, "not paused");
    await api.post(`${Q("orders")}/resume`, {});
    assert(!(await api.get<QueueSummary>(Q("orders"))).isPaused, "still paused");
  });
  await check("clean completed jobs", async () => {
    const before = (await api.get<QueueSummary>(Q("emails"))).counts.completed;
    const r = await api.post<{ removed: number }>(`${Q("emails")}/clean`, { state: "completed", grace: 0, limit: 1000 });
    eq(r.removed, before, "removed");
    eq((await api.get<QueueSummary>(Q("emails"))).counts.completed, 0, "completed left");
  });
  await check("retry-all failed", async () => {
    await api.post(`${Q("stuck")}/retry-all`, { state: "failed" });
    eq((await api.get<QueueSummary>(Q("stuck"))).counts.failed, 0, "failed left");
  });
  await check("drain (waiting + delayed)", async () => {
    await api.post(`${Q("frozen")}/drain`, { includeDelayed: true });
    eq((await api.get<QueueSummary>(Q("frozen"))).counts.waiting, 0, "waiting left");
  });
  await check("hide a queue, then show it again", async () => {
    await api.post(`${C()}/hidden-queues`, { queueName: "reports" });
    const hidden = await api.get<QueueSummary[]>(`${C()}/queues`);
    assert(!hidden.some((q) => q.name === "reports"), "still listed");
    await api.del(`${C()}/hidden-queues/reports`);
    assert((await api.get<QueueSummary[]>(`${C()}/queues`)).some((q) => q.name === "reports"), "not back");
  });
  await check("obliterate removes the queue and everything in it", async () => {
    await api.post(`${Q("frozen")}/obliterate`, {});
    const list = await api.get<QueueSummary[]>(`${C()}/queues?refresh=1`);
    assert(!list.some((q) => q.name === "frozen"), "frozen still listed");
  });

  // ---------------------------------------------------------------------------
  heading("Health monitor");
  await check(`health: ${label} card and a rate after two samples`, async () => {
    const first = await api.get<ConnectionHealth[]>("/health/connections");
    const h0 = first.find((h) => h.connectionId === cid);
    assert(h0 && h0.kind === t.kind && h0.ok && h0.info, JSON.stringify(h0).slice(0, 300));
    if (h0.info.backend === "postgres") assert(pg && h0.info.jobTableBytes > 0 && h0.info.maxConnections > 0, "sizes");
    else assert(!pg && h0.info.usedMemoryBytes > 0 && h0.info.connectedClients > 0, `redis info ${JSON.stringify(h0.info).slice(0, 200)}`);
    const h = await waitFor(pg ? "a transactions/sec rate" : "a commands/sec rate", async () => {
      const list = await api.get<ConnectionHealth[]>("/health/connections");
      const x = list.find((y) => y.connectionId === cid);
      return x && x.commandsPerSec !== null ? x : null;
    }, 15_000, 1000);
    info(`${pg ? "tx/s" : "cmd/s"} ${h.commandsPerSec} · ${h.info?.backend === "postgres" ? `${h.info.connectedClients}/${h.info.maxConnections} connections` : `cpu ${h.cpuCores}`}`);
  });

  // ---------------------------------------------------------------------------
  heading("Connection settings");
  await check("rename the connection", async () => {
    const c = await api.patch<RedisConnection>(C(), { name: `${t.kind}-smoke-renamed` });
    eq(c.name, `${t.kind}-smoke-renamed`, "name");
  });
  const otherScheme = pg ? "redis://localhost:6379" : "postgres://u:p@localhost/db";
  await check(`editing the URL to ${otherScheme.split(":")[0]}:// is refused (kind is fixed)`, () => api.expect(400, "PATCH", C(), { url: otherScheme }));
  await check("kind cannot be changed by a PATCH", async () => {
    await api.request("PATCH", C(), { kind: pg ? "redis" : "postgres" });
    eq((await api.get<RedisConnection[]>("/connections")).find((c) => c.id === cid)?.kind, t.kind, "kind");
  });
  if (!pg) {
    await check("a Redis edit still works: prefix and cluster flag round-trip", async () => {
      const c = await api.patch<RedisConnection>(C(), { cluster: false, prefix: t.ns });
      assert(c.prefix === t.ns && c.cluster === false && c.status?.ok, JSON.stringify(c));
    });
  }

  // ---------------------------------------------------------------------------
  if (pro) await runPro(ctx, cid, Q);
  return cid;
}

async function runPro(ctx: Ctx, cid: string, Q: (q: string) => string): Promise<void> {
  const { api } = ctx;

  heading("Pro: flows, folders, alerts, roles, audit");
  await check("flows graph: parts → assemble edge detected from job data", async () => {
    const g = await api.get<FlowGraph>(`/connections/${cid}/flows`);
    const edge = g.edges.find((e) => e.from === "parts" && e.to === "assemble") ?? g.edges.find((e) => e.to === "parts" && e.from === "assemble");
    assert(edge, `edges: ${JSON.stringify(g.edges)}`);
  });
  await check(`folders: create one and put a ${ctx.target.kind} queue in it`, async () => {
    const f = await api.post<Folder>("/folders", { name: "Smoke folder" });
    const updated = await api.put<Folder>(`/folders/${f.id}/queues`, { queues: [{ connectionId: cid, queueName: "orders" }] });
    assert(JSON.stringify(updated).includes("orders"), JSON.stringify(updated));
    await api.del(`/folders/${f.id}`);
  });
  await check(`alerts: a waiting_above rule fires on the ${ctx.target.kind} queue`, async () => {
    const alert = await api.post<Alert>("/alerts", {
      name: "orders backlog",
      scope: { type: "queue", connectionId: cid, queueName: "orders" },
      condition: { kind: "waiting_above", threshold: 10 },
    });
    const snap = await waitFor("the alert to show in Needs attention", async () => {
      const s = await api.get<AttentionSnapshot>("/attention");
      return s.findings.some((f) => f.alertId === alert.id && f.queueName === "orders") ? s : null;
    }, 20_000, 500);
    info(`finding: ${JSON.stringify(snap.findings.find((f) => f.alertId === alert.id)?.value)} waiting > 10`);
    const events = await api.get<AlertEvent[]>("/alerts/events");
    assert(events.some((e) => e.alertId === alert.id && e.status === "fired"), `events: ${JSON.stringify(events).slice(0, 300)}`);
    await api.del(`/alerts/${alert.id}`);
  });
  await check(`roles: a viewer can read the ${ctx.target.kind} queue and cannot remove a job (403)`, async () => {
    await api.post("/users", { email: "viewer@smoke.test", name: "Viewer", role: "viewer", password: "viewer-password-1" });
    const viewer = new Api(ctx.base);
    await viewer.post("/auth/login", { email: "viewer@smoke.test", password: "viewer-password-1" });
    const page = await viewer.get<JobsPage>(`${Q("orders")}/jobs?state=waiting&pageSize=1`);
    await viewer.expect(403, "DELETE", `${Q("orders")}/jobs/${page.jobs[0]!.id}`);
    await viewer.expect(403, "POST", `${Q("orders")}/pause`, {});
  });
  await check(`audit log recorded the actions on the ${ctx.target.kind} connection`, async () => {
    const page = await api.get<AuditPage>("/audit");
    const actions = new Set(page.entries.map((e) => (e as { action: string }).action));
    for (const a of ["connection.create", "job.remove", "queue.pause", "queue.obliterate"]) assert(actions.has(a), `missing ${a} in ${[...actions].join(", ")}`);
  });
}

/** Deleting the connection is the last step: everything above used it. */
export async function runCleanup(api: Api, cid: string): Promise<void> {
  heading("Delete the connection");
  await check("delete the connection; its queues are gone from the API", async () => {
    await api.del(`/connections/${cid}`);
    eq((await api.get<RedisConnection[]>("/connections")).length, 0, "connections left");
    await api.expect(404, "GET", `/connections/${cid}/queues`);
  });
}
