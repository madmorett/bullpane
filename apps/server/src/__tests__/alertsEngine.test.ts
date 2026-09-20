/**
 * The alerts engine's decision machine, driven with a fake inspector.
 *
 * This is where the reported bug lived, and it had no test at all. What is
 * pinned down here:
 *
 *  - error alerts are measured from BullMQ's cumulative metrics counters and
 *    NEVER from the completed/failed sorted sets, so a queue using
 *    `removeOnComplete` no longer reads as a queue that fails constantly;
 *  - a queue without metrics makes the alert inert, visibly, with ONE
 *    informative event and no notification (not a fired alert, not silence);
 *  - a fresh process is "accumulating history", never "zero failures";
 *  - pausing a queue does not fire a backlog alert.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Alert, AlertCondition } from "@bullpane/shared";
import { AlertsEngine, summarise } from "../alerts/engine";
import type { Sample } from "../alerts/evaluate";
import type { AlertRow } from "../db/schema";

const T0 = 1_700_000_000_000;
const MIN = 60_000;

// --- fakes -----------------------------------------------------------------

interface FakeQueue {
  /** cumulative counters; null = queue collects no metrics */
  completed: number | null;
  failed: number | null;
  counts: { waiting: number; paused: number; prioritized: number };
}

function fakeWorld() {
  const queues = new Map<string, FakeQueue>();

  const inspector = {
    config: { id: "conn-1", url: "redis://x", prefix: "bull", cluster: false },
    getMetricsCounters: vi.fn(async (name: string) => {
      const q = queues.get(name);
      return { completed: q?.completed ?? null, failed: q?.failed ?? null, collectedAt: now };
    }),
    getQueueStats: vi.fn(async (names: string[]) => {
      const out: Record<string, unknown> = {};
      for (const n of names) {
        const q = queues.get(n);
        if (!q) continue;
        out[n] = {
          counts: {
            waiting: q.counts.waiting,
            active: 0,
            completed: 0,
            failed: 0,
            delayed: 0,
            prioritized: q.counts.prioritized,
            paused: q.counts.paused,
            "waiting-children": 0,
          },
          isPaused: q.counts.paused > 0,
          isPro: false,
          groupsCount: 0,
          rates: { windowMinutes: 60, completed: 0, failed: 0, successPct: null, source: "zset", retentionSkewed: false },
          library: null,
          schedulersCount: 0,
        };
      }
      return out;
    }),
    discoverQueues: vi.fn(async () => [...queues.keys()]),
    // The zset window read must never be reached by an error alert again.
    getWindowCounts: vi.fn(async () => {
      throw new Error("getWindowCounts must not be used by alerts: it lies under removeOnComplete");
    }),
  };

  let now = T0;
  const events: Array<{ status: string; message: string; value: number | null; queueName: string | null }> = [];
  const delivered: Array<{ status: string }> = [];

  const alerts = {
    listRows: vi.fn(async () => rows),
    setState: vi.fn(async (_id: string, s: { firing: boolean; lastFiredAt: Date | null }) => {
      // The row IS the state, exactly like MySQL: a test that pre-seeds
      // `firing: true` must see it, not a separate mirror starting at false.
      rows[0]!.firing = s.firing;
      rows[0]!.lastFiredAt = s.lastFiredAt;
    }),
    recordEvent: vi.fn(async (e: { status: string; message: string; value: number | null; queueName: string | null }) => {
      events.push(e);
    }),
    pruneEvents: vi.fn(async () => undefined),
  };

  let rows: AlertRow[] = [];

  const engine = new AlertsEngine({
    config: { alertsInterval: 15, publicUrl: "http://localhost:3000" } as never,
    alerts: alerts as never,
    connections: {
      getRow: vi.fn(async () => ({ id: "conn-1", name: "Prod" })),
      inspectorFor: () => inspector as never,
    } as never,
    folders: { get: vi.fn(async () => ({ id: "f1", name: "Payments", queues: folderQueues })) } as never,
    edition: { getEdition: () => ({ features: { alerts: true } }) } as never,
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    fetch: vi.fn(async () => {
      delivered.push({ status: "sent" });
      return new Response("ok", { status: 200 });
    }) as never,
  });

  let folderQueues: Array<{ connectionId: string; queueName: string }> = [];

  return {
    engine,
    inspector,
    events,
    state: {
      get firing() {
        return rows[0]?.firing ?? false;
      },
      get lastFiredAt() {
        return rows[0]?.lastFiredAt ?? null;
      },
    },
    delivered,
    queues,
    setAlert(condition: AlertCondition, overrides: Partial<AlertRow> = {}) {
      rows = [
        {
          id: "alert-1",
          name: "payments failures",
          enabled: true,
          scopeType: "queue",
          connectionId: "conn-1",
          queueName: "payments",
          folderId: null,
          condition,
          channels: [{ type: "webhook", url: "https://example.com/hook" }],
          cooldownMinutes: 30,
          createdAt: new Date(T0),
          lastFiredAt: null,
          firing: false,
          ...overrides,
        } as AlertRow,
      ];
    },
    setFolderAlert(condition: AlertCondition, queueNames: string[]) {
      folderQueues = queueNames.map((queueName) => ({ connectionId: "conn-1", queueName }));
      rows = [
        {
          id: "alert-1",
          name: "payments folder",
          enabled: true,
          scopeType: "folder",
          connectionId: null,
          queueName: null,
          folderId: "f1",
          condition,
          channels: [{ type: "webhook", url: "https://example.com/hook" }],
          cooldownMinutes: 30,
          createdAt: new Date(T0),
          lastFiredAt: null,
          firing: false,
        } as AlertRow,
      ];
    },
    async tickAt(t: number) {
      now = t;
      vi.setSystemTime(t);
      await engine.tick();
    },
    measurement: () => engine.measurementOf("alert-1"),
  };
}

const rate = (percent: number, windowMinutes = 5, minSample = 20): AlertCondition => ({
  kind: "failed_rate_above",
  percent,
  windowMinutes,
  minSample,
});
const failedAbove = (threshold: number, windowMinutes = 5): AlertCondition => ({ kind: "failed_above", threshold, windowMinutes });

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
});

describe("error alerts are measured from metrics counters, never from the zsets", () => {
  it("does not fire on a healthy queue that prunes its completed jobs (THE bug)", async () => {
    const w = fakeWorld();
    // Real traffic over the window: 300 ok / 15 failed = 4.8%.
    // The completed zset only holds 50 of those, so ZCOUNT would say 23.1% and
    // a "> 10%" alert would fire on a perfectly healthy queue.
    w.queues.set("payments", { completed: 0, failed: 0, counts: { waiting: 0, paused: 0, prioritized: 0 } });
    w.setAlert(rate(10, 5));

    await w.tickAt(T0);
    expect(w.measurement()).toMatchObject({ source: "metrics", state: "warming_up" });

    w.queues.set("payments", { completed: 300, failed: 15, counts: { waiting: 0, paused: 0, prioritized: 0 } });
    await w.tickAt(T0 + 5 * MIN);

    expect(w.measurement()).toMatchObject({ state: "ok" });
    expect(w.state.firing).toBe(false);
    expect(w.events.filter((e) => e.status === "fired")).toHaveLength(0);
    // and the lying source was never consulted
    expect(w.inspector.getWindowCounts).not.toHaveBeenCalled();
  });

  it("fires on a real burst and resolves when it passes", async () => {
    const w = fakeWorld();
    w.queues.set("payments", { completed: 0, failed: 0, counts: { waiting: 0, paused: 0, prioritized: 0 } });
    w.setAlert(rate(10, 1));

    await w.tickAt(T0);
    // 30 ok / 20 failed in the window = 40%
    w.queues.set("payments", { completed: 30, failed: 20, counts: { waiting: 0, paused: 0, prioritized: 0 } });
    await w.tickAt(T0 + 1 * MIN);
    expect(w.state.firing).toBe(true);
    const fired = w.events.find((e) => e.status === "fired");
    expect(fired?.value).toBeCloseTo(40, 0);

    // next window: 30 ok / 1 failed = 3.2%, even though the cumulative failed
    // count (and the failed zset) is still climbing
    w.queues.set("payments", { completed: 60, failed: 21, counts: { waiting: 0, paused: 0, prioritized: 0 } });
    await w.tickAt(T0 + 2 * MIN);
    expect(w.state.firing).toBe(false);
    expect(w.events.some((e) => e.status === "resolved")).toBe(true);
  });

  it("failed_above counts the delta in the window, not the size of the failed zset", async () => {
    const w = fakeWorld();
    // A long-lived queue with 10.000 lifetime failures still on the zset.
    w.queues.set("payments", { completed: 500_000, failed: 10_000, counts: { waiting: 0, paused: 0, prioritized: 0 } });
    w.setAlert(failedAbove(5, 1));

    await w.tickAt(T0);
    // only 2 new failures in this window: not a breach, despite 10.000 on file
    w.queues.set("payments", { completed: 500_100, failed: 10_002, counts: { waiting: 0, paused: 0, prioritized: 0 } });
    await w.tickAt(T0 + 1 * MIN);
    expect(w.state.firing).toBe(false);

    // now 40 new failures in one window: a breach
    w.queues.set("payments", { completed: 500_200, failed: 10_042, counts: { waiting: 0, paused: 0, prioritized: 0 } });
    await w.tickAt(T0 + 2 * MIN);
    expect(w.state.firing).toBe(true);
    expect(w.events.find((e) => e.status === "fired")?.value).toBe(40);
  });
});

describe("a queue without metrics", () => {
  it("makes the alert visibly inert: one event, no firing, no delivery", async () => {
    const w = fakeWorld();
    w.queues.set("payments", { completed: null, failed: null, counts: { waiting: 0, paused: 0, prioritized: 0 } });
    w.setAlert(rate(10, 5));

    await w.tickAt(T0);
    expect(w.measurement()).toMatchObject({ source: "metrics", state: "no_metrics" });
    expect(w.state.firing).toBe(false);
    const notices = w.events.filter((e) => e.status === "no_metrics");
    expect(notices).toHaveLength(1);
    expect(notices[0]!.message).toContain("maxDataPoints");
    expect(w.delivered).toHaveLength(0); // a config problem, not an incident
  });

  it("does not repeat the notice every tick (cooldown), but does remind later", async () => {
    const w = fakeWorld();
    w.queues.set("payments", { completed: null, failed: null, counts: { waiting: 0, paused: 0, prioritized: 0 } });
    w.setAlert(rate(10, 5), { cooldownMinutes: 30 });

    for (let i = 0; i < 20; i++) await w.tickAt(T0 + i * 15_000);
    expect(w.events.filter((e) => e.status === "no_metrics")).toHaveLength(1);

    await w.tickAt(T0 + 31 * MIN);
    expect(w.events.filter((e) => e.status === "no_metrics")).toHaveLength(2);
  });

  it("starts measuring by itself once the worker turns metrics on", async () => {
    const w = fakeWorld();
    w.queues.set("payments", { completed: null, failed: null, counts: { waiting: 0, paused: 0, prioritized: 0 } });
    w.setAlert(rate(10, 1));
    await w.tickAt(T0);
    expect(w.measurement()?.state).toBe("no_metrics");

    // deploy: metrics on
    w.queues.set("payments", { completed: 100, failed: 1, counts: { waiting: 0, paused: 0, prioritized: 0 } });
    await w.tickAt(T0 + 1 * MIN);
    expect(w.measurement()?.state).toBe("warming_up");
    w.queues.set("payments", { completed: 200, failed: 40, counts: { waiting: 0, paused: 0, prioritized: 0 } });
    await w.tickAt(T0 + 2 * MIN);
    expect(w.measurement()?.state).toBe("ok");
    expect(w.state.firing).toBe(true);
  });

  it("a folder alert measures the queues it can and names the ones it cannot", async () => {
    const w = fakeWorld();
    w.queues.set("with-metrics", { completed: 0, failed: 0, counts: { waiting: 0, paused: 0, prioritized: 0 } });
    w.queues.set("no-metrics", { completed: null, failed: null, counts: { waiting: 0, paused: 0, prioritized: 0 } });
    w.setFolderAlert(rate(10, 1), ["with-metrics", "no-metrics"]);

    await w.tickAt(T0);
    w.queues.set("with-metrics", { completed: 10, failed: 40, counts: { waiting: 0, paused: 0, prioritized: 0 } });
    await w.tickAt(T0 + 1 * MIN);

    const m = w.measurement();
    expect(m?.state).toBe("ok"); // it can still fire on the measurable queue
    expect(m?.queuesWithoutMetrics).toEqual(["no-metrics"]);
    expect(w.state.firing).toBe(true);
    expect(w.events.find((e) => e.status === "fired")?.queueName).toBe("with-metrics");
  });
});

describe("insufficient history", () => {
  it("a restarted process reports warming_up, never zero failures", async () => {
    const w = fakeWorld();
    // The queue already has a huge lifetime failure count when we boot.
    w.queues.set("payments", { completed: 1_000_000, failed: 900_000, counts: { waiting: 0, paused: 0, prioritized: 0 } });
    w.setAlert(failedAbove(5, 5));

    await w.tickAt(T0);
    // NOT breached (we did not read 900.000 as "this window") and NOT resolved
    expect(w.state.firing).toBe(false);
    expect(w.events).toHaveLength(0);
    expect(w.measurement()).toMatchObject({ state: "warming_up", windowCoveredMs: null });
  });

  it("keeps a firing alert firing while history is rebuilt, instead of falsely resolving", async () => {
    const w = fakeWorld();
    w.queues.set("payments", { completed: 100, failed: 100, counts: { waiting: 0, paused: 0, prioritized: 0 } });
    // simulate a process that was already firing before the restart
    w.setAlert(failedAbove(5, 5), { firing: true, lastFiredAt: new Date(T0 - 60 * MIN) });

    await w.tickAt(T0);
    expect(w.state.firing).toBe(true); // no false "resolved" from an unknown window
    expect(w.events.some((e) => e.status === "resolved")).toBe(false);
  });

  it("a reset counter (redis restarted / queue obliterated) never reports a negative delta", async () => {
    const w = fakeWorld();
    w.queues.set("payments", { completed: 10_000, failed: 500, counts: { waiting: 0, paused: 0, prioritized: 0 } });
    w.setAlert(failedAbove(5, 1));
    await w.tickAt(T0);
    await w.tickAt(T0 + 1 * MIN);

    // FLUSHALL / obliterate: counters back to near zero
    w.queues.set("payments", { completed: 3, failed: 0, counts: { waiting: 0, paused: 0, prioritized: 0 } });
    await w.tickAt(T0 + 2 * MIN);
    expect(w.measurement()?.state).toBe("warming_up");
    expect(w.state.firing).toBe(false);
    expect(w.events.filter((e) => e.status === "fired")).toHaveLength(0);
  });
});

describe("waiting_above is a gauge and excludes paused", () => {
  it("does not fire when a queue is paused for maintenance", async () => {
    const w = fakeWorld();
    // The operator paused the queue: BullMQ moved every waiting job into
    // `paused`. That is intentional, not a backlog incident.
    w.queues.set("payments", { completed: 0, failed: 0, counts: { waiting: 0, paused: 5_000, prioritized: 0 } });
    w.setAlert({ kind: "waiting_above", threshold: 100 });

    await w.tickAt(T0);
    expect(w.state.firing).toBe(false);
    expect(w.measurement()).toMatchObject({ source: "counts", state: "ok" });
  });

  it("counts prioritized as real backlog", async () => {
    const w = fakeWorld();
    w.queues.set("payments", { completed: 0, failed: 0, counts: { waiting: 60, paused: 0, prioritized: 60 } });
    w.setAlert({ kind: "waiting_above", threshold: 100 });
    await w.tickAt(T0);
    expect(w.state.firing).toBe(true);
    expect(w.events.find((e) => e.status === "fired")?.value).toBe(120);
  });
});

describe("summarise", () => {
  const ok = (state: Sample["state"]): Sample => ({ breached: false, value: 1, threshold: 5, unit: "jobs", state });

  it("is ok when at least one queue is measurable, and names the rest", () => {
    const m = summarise(failedAbove(5), [ok("ok"), ok("no_metrics")], ["b"], 300_000);
    expect(m).toMatchObject({ source: "metrics", state: "ok", queuesWithoutMetrics: ["b"], windowCoveredMs: 300_000 });
  });

  it("prefers no_metrics over warming_up when nothing is measurable (it is the actionable one)", () => {
    const m = summarise(failedAbove(5), [ok("warming_up"), ok("no_metrics")], ["b"], null);
    expect(m).toMatchObject({ state: "no_metrics", windowCoveredMs: null });
  });

  it("marks the waiting gauge as counts-sourced", () => {
    const m = summarise({ kind: "waiting_above", threshold: 5 }, [ok("ok")], [], null);
    expect(m.source).toBe("counts");
  });
});

describe("forget", () => {
  it("drops the history of a deleted alert so a reused id cannot inherit a stale window", async () => {
    const w = fakeWorld();
    w.queues.set("payments", { completed: 0, failed: 0, counts: { waiting: 0, paused: 0, prioritized: 0 } });
    w.setAlert(failedAbove(5, 1));
    await w.tickAt(T0);
    expect(w.measurement()).toBeDefined();
    w.engine.forget("alert-1");
    expect(w.measurement()).toBeUndefined();

    // and measuring restarts from warming_up rather than diffing against the
    // pre-delete baseline
    w.queues.set("payments", { completed: 999, failed: 999, counts: { waiting: 0, paused: 0, prioritized: 0 } });
    await w.tickAt(T0 + 1 * MIN);
    expect(w.measurement()?.state).toBe("warming_up");
  });
});

/** The DTO the web consumes must carry the measurement, not just firing. */
describe("Alert DTO contract", () => {
  it("measurement is part of the shared Alert type", () => {
    const a: Alert = {
      id: "a",
      name: "n",
      enabled: true,
      scope: { type: "queue", connectionId: "c", queueName: "q" },
      condition: failedAbove(5),
      channels: [{ type: "webhook", url: "https://x.dev/h" }],
      cooldownMinutes: 30,
      createdAt: new Date(T0).toISOString(),
      lastFiredAt: null,
      firing: false,
      measurement: { source: "metrics", state: "no_metrics", windowCoveredMs: null },
    };
    expect(a.measurement?.state).toBe("no_metrics");
  });
});
