import { describe, expect, it } from "vitest";
import { pickWorst } from "../alerts/engine";
import { type AlertStateInput, evaluateAlert, formatMessage, measure } from "../alerts/evaluate";

const MIN = 60_000;
const NOW = 1_700_000_000_000;

describe("measure", () => {
  it("waiting_above compares strictly above the threshold", () => {
    const c = { kind: "waiting_above", threshold: 100 } as const;
    expect(measure(c, { kind: "waiting_above", waiting: 100 }).breached).toBe(false);
    expect(measure(c, { kind: "waiting_above", waiting: 101 })).toMatchObject({ breached: true, value: 101, threshold: 100 });
  });

  it("failed_above uses the window delta", () => {
    const c = { kind: "failed_above", threshold: 5, windowMinutes: 5 } as const;
    expect(measure(c, { kind: "failed_above", failed: 6, state: "ok" }).breached).toBe(true);
    expect(measure(c, { kind: "failed_above", failed: 5, state: "ok" }).breached).toBe(false);
  });

  it("failed_above refuses to judge without a delta", () => {
    const c = { kind: "failed_above", threshold: 5, windowMinutes: 5 } as const;
    // no metrics on the queue: NOT zero failures, unknown
    expect(measure(c, { kind: "failed_above", failed: null, state: "no_metrics" })).toMatchObject({ breached: null, value: null, state: "no_metrics" });
    // history too short: never extrapolate a partial window
    expect(measure(c, { kind: "failed_above", failed: 99, state: "warming_up" })).toMatchObject({ breached: null, value: null, state: "warming_up" });
  });

  it("failed_rate_above is inconclusive below minSample", () => {
    const c = { kind: "failed_rate_above", percent: 10, windowMinutes: 5, minSample: 20 } as const;
    expect(measure(c, { kind: "failed_rate_above", failed: 5, completed: 5, state: "ok" }).breached).toBeNull();
    expect(measure(c, { kind: "failed_rate_above", failed: 3, completed: 17, state: "ok" })).toMatchObject({ breached: true, value: 15 });
    expect(measure(c, { kind: "failed_rate_above", failed: 2, completed: 18, state: "ok" })).toMatchObject({ breached: false, value: 10 });
  });

  it("failed_rate_above is inconclusive without metrics, even with a big failed count", () => {
    const c = { kind: "failed_rate_above", percent: 10, windowMinutes: 5, minSample: 20 } as const;
    expect(measure(c, { kind: "failed_rate_above", failed: null, completed: null, state: "no_metrics" })).toMatchObject({
      breached: null,
      state: "no_metrics",
    });
  });

  it("refuses a measurement of a different kind", () => {
    expect(() => measure({ kind: "failed_above", threshold: 1, windowMinutes: 5 }, { kind: "waiting_above", waiting: 1 })).toThrow();
  });
});

describe("evaluateAlert state machine", () => {
  const idle = { firing: false, lastFiredAt: null, cooldownMinutes: 30 };

  it("fires when a non-firing alert breaches", () => {
    const d = evaluateAlert(idle, { breached: true }, NOW);
    expect(d).toEqual({ action: "fire", firing: true, lastFiredAt: NOW });
  });

  it("does nothing when a non-firing alert is healthy", () => {
    expect(evaluateAlert(idle, { breached: false }, NOW)).toEqual({ action: "none", firing: false, lastFiredAt: null });
  });

  it("keeps state when the sample is inconclusive", () => {
    const firing = { firing: true, lastFiredAt: new Date(NOW - 5 * MIN), cooldownMinutes: 30 };
    expect(evaluateAlert(firing, { breached: null }, NOW)).toEqual({ action: "none", firing: true, lastFiredAt: NOW - 5 * MIN });
    expect(evaluateAlert(idle, { breached: null }, NOW).action).toBe("none");
  });

  it("stays quiet while firing inside the cooldown", () => {
    const firing = { firing: true, lastFiredAt: NOW - 10 * MIN, cooldownMinutes: 30 };
    expect(evaluateAlert(firing, { breached: true }, NOW)).toEqual({ action: "none", firing: true, lastFiredAt: NOW - 10 * MIN });
  });

  it("re-notifies once the cooldown has elapsed", () => {
    const firing = { firing: true, lastFiredAt: NOW - 30 * MIN, cooldownMinutes: 30 };
    expect(evaluateAlert(firing, { breached: true }, NOW)).toEqual({ action: "renotify", firing: true, lastFiredAt: NOW });
  });

  it("re-notifies immediately if firing but lastFiredAt is unknown", () => {
    expect(evaluateAlert({ firing: true, lastFiredAt: null, cooldownMinutes: 30 }, { breached: true }, NOW).action).toBe("renotify");
  });

  it("resolves when a firing alert becomes healthy", () => {
    const firing = { firing: true, lastFiredAt: NOW - MIN, cooldownMinutes: 30 };
    expect(evaluateAlert(firing, { breached: false }, NOW)).toEqual({ action: "resolve", firing: false, lastFiredAt: NOW - MIN });
  });

  it("walks the full lifecycle: fire → quiet → renotify → resolve → fire", () => {
    let state: AlertStateInput = { ...idle };
    let d = evaluateAlert(state, { breached: true }, NOW);
    expect(d.action).toBe("fire");
    state = { ...state, firing: d.firing, lastFiredAt: d.lastFiredAt };

    d = evaluateAlert(state, { breached: true }, NOW + 5 * MIN);
    expect(d.action).toBe("none");

    d = evaluateAlert(state, { breached: true }, NOW + 31 * MIN);
    expect(d.action).toBe("renotify");
    state = { ...state, firing: d.firing, lastFiredAt: d.lastFiredAt };
    expect(state.lastFiredAt).toBe(NOW + 31 * MIN);

    d = evaluateAlert(state, { breached: false }, NOW + 40 * MIN);
    expect(d.action).toBe("resolve");
    state = { ...state, firing: d.firing, lastFiredAt: d.lastFiredAt };

    d = evaluateAlert(state, { breached: true }, NOW + 41 * MIN);
    expect(d.action).toBe("fire");
  });
});

describe("pickWorst (folder alerts)", () => {
  const c = { kind: "waiting_above", threshold: 10 } as const;
  const t = (...names: string[]) => names.map((queueName) => ({ connectionId: "c1", queueName }));

  it("prefers a breached queue over a healthy one with a higher value", () => {
    const r = pickWorst(
      c,
      t("a", "b"),
      [
        { breached: false, value: 999, threshold: 10, unit: "jobs", state: "ok" },
        { breached: true, value: 11, threshold: 10, unit: "jobs", state: "ok" },
      ],
    );
    expect(r.target?.queueName).toBe("b");
    expect(r.sample.breached).toBe(true);
  });

  it("reports the highest value among breached queues", () => {
    const r = pickWorst(
      c,
      t("a", "b", "c"),
      [
        { breached: true, value: 11, threshold: 10, unit: "jobs", state: "ok" },
        { breached: true, value: 50, threshold: 10, unit: "jobs", state: "ok" },
        { breached: false, value: 1, threshold: 10, unit: "jobs", state: "ok" },
      ],
    );
    expect(r.target?.queueName).toBe("b");
    expect(r.sample.value).toBe(50);
  });

  it("is inconclusive when every queue is inconclusive", () => {
    const rate = { kind: "failed_rate_above", percent: 5, windowMinutes: 5, minSample: 20 } as const;
    const r = pickWorst(rate, t("a"), [{ breached: null, value: null, threshold: 5, unit: "%", state: "ok" }]);
    expect(r.sample.breached).toBeNull();
    expect(r.target).toBeNull();
  });
});

describe("formatMessage", () => {
  it("describes fired and resolved states", () => {
    const condition = { kind: "waiting_above", threshold: 100 } as const;
    const sample = { breached: true, value: 150, threshold: 100, unit: "jobs", state: "ok" } as const;
    const fired = formatMessage({ kind: "waiting_above", condition, status: "fired", queueName: "payments.charge", connectionName: "Prod", sample });
    expect(fired).toContain('queue "payments.charge"');
    expect(fired).toContain("150");
    const resolved = formatMessage({ kind: "waiting_above", condition, status: "resolved", queueName: "payments.charge", connectionName: "Prod", sample: { ...sample, breached: false, value: 3 } });
    expect(resolved).toMatch(/back below threshold/);
  });
});
