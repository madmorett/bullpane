/**
 * The delta window: turning BullMQ's cumulative counters into "what happened in
 * the last N minutes". Pure logic, no Redis.
 *
 * The scenario every test here defends is the one the ZCOUNT implementation got
 * wrong: a queue that prunes its completed jobs. The counters keep growing, so
 * the delta stays right no matter what retention does to the sorted sets.
 */
import { describe, expect, it } from "vitest";
import { CounterHistory, CounterHistoryStore, MAX_SAMPLES } from "../alerts/metricsWindow";

const T0 = 1_700_000_000_000;
const SEC = 1_000;
const MIN = 60_000;
/** the engine's default tick */
const TICK = 15 * SEC;

describe("CounterHistory", () => {
  it("is warming up until a sample older than the window exists", () => {
    const h = new CounterHistory();
    const window = 5 * MIN;
    // first ever reading: nothing to diff against
    expect(h.push({ t: T0, completed: 100, failed: 5 }, window)).toMatchObject({ state: "warming_up", failed: null, completed: null });
    // one tick later there IS a delta, but it covers 15 s, not 5 min. Reporting
    // it would understate a 5-minute claim, so it stays inconclusive.
    expect(h.push({ t: T0 + TICK, completed: 130, failed: 6 }, window)).toMatchObject({ state: "warming_up", failed: null });
  });

  it("reports the delta once the window is covered", () => {
    const h = new CounterHistory();
    const window = 1 * MIN;
    h.push({ t: T0, completed: 0, failed: 0 }, window);
    let out = h.push({ t: T0 + 30 * SEC, completed: 50, failed: 1 }, window);
    expect(out.state).toBe("warming_up");
    out = h.push({ t: T0 + 60 * SEC, completed: 100, failed: 2 }, window);
    expect(out).toMatchObject({ state: "ok", completed: 100, failed: 2, windowCoveredMs: 60 * SEC });
  });

  it("survives removeOnComplete: the delta is the real traffic, not what is left in the zsets", () => {
    // Reproduces the bug report. Real traffic: 300 ok / 15 failed = 4.8%.
    // ZCOUNT over the pruned zsets would say 50 ok / 15 failed = 23.1%.
    const h = new CounterHistory();
    const window = 5 * MIN;
    h.push({ t: T0, completed: 0, failed: 0 }, window);
    const out = h.push({ t: T0 + 5 * MIN, completed: 300, failed: 15 }, window);
    expect(out).toMatchObject({ state: "ok", completed: 300, failed: 15 });
    const rate = (out.failed! / (out.completed! + out.failed!)) * 100;
    expect(rate).toBeCloseTo(4.76, 1);
  });

  it("catches a burst and the return to normal (the owner's validated table)", () => {
    const h = new CounterHistory();
    const window = 1 * MIN;
    const rate = (c: number | null, f: number | null) => Math.round((f! / (c! + f!)) * 1000) / 10;

    h.push({ t: T0, completed: 0, failed: 0 }, window);
    let out = h.push({ t: T0 + 1 * MIN, completed: 30, failed: 1 }, window);
    expect(rate(out.completed, out.failed)).toBeCloseTo(3.2, 1);
    out = h.push({ t: T0 + 2 * MIN, completed: 60, failed: 2 }, window);
    expect(rate(out.completed, out.failed)).toBeCloseTo(3.2, 1);
    // burst
    out = h.push({ t: T0 + 3 * MIN, completed: 90, failed: 22 }, window);
    expect(out).toMatchObject({ completed: 30, failed: 20 });
    expect(rate(out.completed, out.failed)).toBeCloseTo(40, 1);
    // and back to normal: the delta drops even though the cumulative failed
    // count (and the failed zset) keeps climbing
    out = h.push({ t: T0 + 4 * MIN, completed: 120, failed: 23 }, window);
    expect(out).toMatchObject({ completed: 30, failed: 1 });
    expect(rate(out.completed, out.failed)).toBeCloseTo(3.2, 1);
  });

  it("returns no_metrics and forgets history when both counters are absent", () => {
    const h = new CounterHistory();
    const window = 1 * MIN;
    h.push({ t: T0, completed: 10, failed: 1 }, window);
    expect(h.push({ t: T0 + 30 * SEC, completed: null, failed: null }, window)).toMatchObject({
      state: "no_metrics",
      completed: null,
      failed: null,
      windowCoveredMs: null,
    });
    expect(h.size).toBe(0);
    // metrics come back later: a fresh baseline, not a diff against the stale one
    expect(h.push({ t: T0 + 1 * MIN, completed: 500, failed: 50 }, window).state).toBe("warming_up");
    const out = h.push({ t: T0 + 2 * MIN, completed: 510, failed: 51 }, window);
    expect(out).toMatchObject({ state: "ok", completed: 10, failed: 1 });
  });

  it("restarts instead of reporting a negative delta when the counter resets", () => {
    // Redis restarted / queue obliterated: the cumulative counters go back to 0.
    const h = new CounterHistory();
    const window = 1 * MIN;
    h.push({ t: T0, completed: 1000, failed: 40 }, window);
    h.push({ t: T0 + 1 * MIN, completed: 1100, failed: 41 }, window);
    const reset = h.push({ t: T0 + 2 * MIN, completed: 3, failed: 0 }, window);
    expect(reset.state).toBe("warming_up");
    expect(reset.failed).toBeNull();
    // and it rebuilds from the new baseline
    const out = h.push({ t: T0 + 3 * MIN, completed: 20, failed: 2 }, window);
    expect(out).toMatchObject({ state: "ok", completed: 17, failed: 2 });
  });

  it("never reports a negative failed delta even if only one counter drops", () => {
    const h = new CounterHistory();
    const window = 1 * MIN;
    h.push({ t: T0, completed: 100, failed: 10 }, window);
    // failed dropped (a `clean`/obliterate of only the failed metrics hash).
    // The whole series restarts: a delta of 100 completed / -7 failed is not a
    // measurement, it is two different counters being subtracted.
    const out = h.push({ t: T0 + 1 * MIN, completed: 200, failed: 3 }, window);
    expect(out).toMatchObject({ state: "warming_up", failed: null, completed: null });
  });

  it("keeps memory bounded for a long window without losing the edge", () => {
    const h = new CounterHistory();
    const window = 24 * 60 * MIN; // 24 h
    let t = T0;
    let completed = 0;
    // 24 h of 15 s ticks = 5760 pushes
    for (let i = 0; i < 5_760; i++) {
      t += TICK;
      completed += 10;
      h.push({ t, completed, failed: 0 }, window);
    }
    expect(h.size).toBeLessThanOrEqual(MAX_SAMPLES);
    // one more tick past 24 h of history and a real 24 h delta appears
    t += TICK;
    completed += 10;
    const out = h.push({ t, completed, failed: 0 }, window);
    expect(out.state).toBe("ok");
    expect(out.windowCoveredMs).toBeGreaterThanOrEqual(24 * 60 * MIN - 10 * MIN);
  });

  it("keeps memory bounded for a short window too", () => {
    const h = new CounterHistory();
    const window = 1 * MIN;
    let t = T0;
    for (let i = 0; i < 2_000; i++) {
      t += TICK;
      h.push({ t, completed: i, failed: 0 }, window);
    }
    expect(h.size).toBeLessThanOrEqual(MAX_SAMPLES);
    expect(h.size).toBeLessThanOrEqual(8); // 1 min / 15 s + the edge
  });
});

describe("CounterHistoryStore", () => {
  it("keeps one series per (alert, connection, queue)", () => {
    const store = new CounterHistoryStore();
    const window = 1 * MIN;
    const a = CounterHistoryStore.key("alert-1", "conn-1", "emails");
    const b = CounterHistoryStore.key("alert-2", "conn-1", "emails");
    const c = CounterHistoryStore.key("alert-1", "conn-2", "emails");
    store.push(a, { t: T0, completed: 0, failed: 0 }, window);
    store.push(b, { t: T0, completed: 0, failed: 0 }, window);
    store.push(c, { t: T0, completed: 0, failed: 0 }, window);
    expect(store.size).toBe(3);
    // one alert's history does not leak into the other's delta
    expect(store.push(a, { t: T0 + 1 * MIN, completed: 10, failed: 1 }, window)).toMatchObject({ completed: 10, failed: 1 });
    expect(store.push(b, { t: T0 + 1 * MIN, completed: 99, failed: 9 }, window)).toMatchObject({ completed: 99, failed: 9 });
  });

  it("drops every series of a deleted alert", () => {
    const store = new CounterHistoryStore();
    store.push(CounterHistoryStore.key("a1", "c1", "q1"), { t: T0, completed: 0, failed: 0 }, MIN);
    store.push(CounterHistoryStore.key("a1", "c1", "q2"), { t: T0, completed: 0, failed: 0 }, MIN);
    store.push(CounterHistoryStore.key("a2", "c1", "q1"), { t: T0, completed: 0, failed: 0 }, MIN);
    store.dropAlert("a1");
    expect(store.size).toBe(1);
  });

  it("never grows past its ceiling", () => {
    const store = new CounterHistoryStore(10, 3_600_000);
    for (let i = 0; i < 500; i++) {
      store.push(CounterHistoryStore.key(`a${i}`, "c1", "q"), { t: T0 + i, completed: i, failed: 0 }, MIN);
    }
    expect(store.size).toBeLessThanOrEqual(10);
  });
});
