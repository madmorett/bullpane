/**
 * The landing rule for a click on a queue. It's a pure function for a reason:
 * it is the entire fix for task 1 and shouldn't depend on rendering anything
 * to be verified.
 */
import { describe, expect, it } from "vitest";
import type { QueueCounts } from "@bullpane/shared";
import { queueLandingState } from "../queueLanding";

const counts = (patch: Partial<QueueCounts>): QueueCounts => ({
  waiting: 0,
  active: 0,
  completed: 0,
  failed: 0,
  delayed: 0,
  prioritized: 0,
  paused: 0,
  "waiting-children": 0,
  ...patch,
});

describe("queueLandingState", () => {
  it("goes to failed when there is any failure", () => {
    expect(queueLandingState(counts({ failed: 1 }))).toBe("failed");
    expect(queueLandingState(counts({ failed: 1000, waiting: 60, completed: 50_000 }))).toBe("failed");
  });

  it("failed beats waiting — that is what the operator clicked for", () => {
    // The incident case: 22 failures behind 60 waiting. Landing on waiting
    // hides exactly what the red counter was announcing.
    expect(queueLandingState(counts({ waiting: 60, failed: 22 }))).toBe("failed");
  });

  it("with no failures, goes to waiting", () => {
    expect(queueLandingState(counts({ waiting: 5 }))).toBe("waiting");
    expect(queueLandingState(counts({ waiting: 5, completed: 900, active: 3 }))).toBe("waiting");
  });

  it("with no failures and no waiting, lands on prioritized if that is where the jobs are", () => {
    // prioritized IS an inbound queue; going to waiting here would give an empty table.
    expect(queueLandingState(counts({ prioritized: 7 }))).toBe("prioritized");
  });

  it("a healthy, empty queue lands on completed, the only tab with content", () => {
    expect(queueLandingState(counts({ completed: 500 }))).toBe("completed");
    expect(queueLandingState(counts({ active: 2, completed: 500 }))).toBe("completed");
  });

  it("a completely empty queue lands on completed, not on a worse tab", () => {
    expect(queueLandingState(counts({}))).toBe("completed");
  });

  it("does not blow up without counts (a queue whose stats failed)", () => {
    expect(queueLandingState(undefined)).toBe("completed");
    expect(queueLandingState({})).toBe("completed");
  });

  it("delayed / paused / waiting-children do not divert the destination", () => {
    // They are real states, but none is the reason someone opens a queue at 3am.
    expect(queueLandingState(counts({ delayed: 40 }))).toBe("completed");
    expect(queueLandingState(counts({ paused: 40 }))).toBe("completed");
    expect(queueLandingState(counts({ "waiting-children": 40 }))).toBe("completed");
    expect(queueLandingState(counts({ delayed: 40, failed: 1 }))).toBe("failed");
  });
});
