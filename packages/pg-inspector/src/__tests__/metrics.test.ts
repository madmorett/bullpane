import { describe, expect, it } from "vitest";
import { ratesFrom } from "../metrics.js";

const MIN = 60_000;

describe("ratesFrom: success rate from BullMQ's metrics", () => {
  it("counts the minute in progress (count - prevCount), not only the flushed points", () => {
    // Seen live: payments had 5 completed (2 flushed in an earlier minute, 3 this
    // minute) and 1 failure this minute, and the queue list said 100%.
    const now = 100 * MIN + 30_000;
    const rates = ratesFrom({
      windowMinutes: 60,
      now,
      completed: { kind: "completed", count: 5, prevTs: 100 * MIN + 1_000, prevCount: 2, data: [2] },
      failed: { kind: "failed", count: 1, prevTs: 100 * MIN + 5_000, prevCount: 0, data: [] },
      storedCompleted: 0,
      storedFailed: 0,
      prunesCompleted: false,
    });
    expect(rates).toMatchObject({ completed: 5, failed: 1, successPct: 83.3, source: "metrics" });
  });

  it("drops minutes outside the window", () => {
    const now = 200 * MIN;
    // last flush at minute 190; points newest first: 7 (minute 189), 4 (188), 100 (187)
    const rates = ratesFrom({
      windowMinutes: 13,
      now,
      completed: { kind: "completed", count: 111, prevTs: 190 * MIN, prevCount: 111, data: [7, 4, 100] },
      failed: null,
      storedCompleted: 0,
      storedFailed: 0,
      prunesCompleted: false,
    });
    // window = minutes 188..200: the 7 and 4 are in, the 100 (minute 187) is out
    expect(rates).toMatchObject({ completed: 11, failed: 0, successPct: 100 });
  });

  it("falls back to stored rows when the queue has no metrics, flagging pruned retention", () => {
    const rates = ratesFrom({ windowMinutes: 60, now: Date.now(), completed: null, failed: null, storedCompleted: 50, storedFailed: 100, prunesCompleted: true });
    expect(rates).toMatchObject({ source: "zset", successPct: 33.3, retentionSkewed: true });
  });
});
