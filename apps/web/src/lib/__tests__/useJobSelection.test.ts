/**
 * The selection math. What matters here isn't ticking a checkbox — it's the
 * behavior when the table repolls (every 3 s) and the rows move around:
 * the selection is by jobId, ids that leave the page stay selected, and
 * "select all" never touches what is off the visible page.
 */
import { describe, expect, it } from "vitest";
import { applyRange, applyToggle, applyToggleAllVisible, countVisibleSelected } from "../useJobSelection";

const set = (...ids: string[]) => new Set(ids);
const sorted = (s: Set<string>) => [...s].sort();

describe("applyToggle", () => {
  it("checks and unchecks", () => {
    expect(sorted(applyToggle(set(), "a"))).toEqual(["a"]);
    expect(sorted(applyToggle(set("a", "b"), "a"))).toEqual(["b"]);
  });

  it("does not mutate the previous set (React needs a new reference)", () => {
    const before = set("a");
    const after = applyToggle(before, "b");
    expect(sorted(before)).toEqual(["a"]);
    expect(after).not.toBe(before);
  });
});

describe("applyRange (Shift+click)", () => {
  const page = ["1", "2", "3", "4", "5"];

  it("selects the range between the anchor and the clicked id", () => {
    expect(sorted(applyRange(set("2"), page, "2", "4"))).toEqual(["2", "3", "4"]);
  });

  it("works bottom-up", () => {
    expect(sorted(applyRange(set("4"), page, "4", "2"))).toEqual(["2", "3", "4"]);
  });

  it("clicking an ALREADY checked id clears the range instead of selecting it", () => {
    const all = set(...page);
    expect(sorted(applyRange(all, page, "2", "4"))).toEqual(["1", "5"]);
  });

  it("with no anchor, degrades to a plain click", () => {
    expect(sorted(applyRange(set(), page, null, "3"))).toEqual(["3"]);
  });

  it("an anchor that left the page on polling degrades to a plain click, it does not invent a range", () => {
    // This is the real case: the anchor job was processed and left the list
    // between two polling cycles. Guessing a range here would select jobs
    // the operator never saw.
    expect(sorted(applyRange(set(), page, "999", "3"))).toEqual(["3"]);
  });

  it("preserves selected ids that are off the visible page", () => {
    const withOffPage = set("off-1");
    expect(sorted(applyRange(withOffPage, page, "1", "2"))).toEqual(["1", "2", "off-1"]);
  });
});

describe("applyToggleAllVisible", () => {
  const page = ["1", "2", "3"];

  it("selects the whole page when nothing is checked", () => {
    expect(sorted(applyToggleAllVisible(set(), page))).toEqual(["1", "2", "3"]);
  });

  it("selects the whole page when only part of it was checked", () => {
    expect(sorted(applyToggleAllVisible(set("2"), page))).toEqual(["1", "2", "3"]);
  });

  it("clears the page when all of it was checked", () => {
    expect(sorted(applyToggleAllVisible(set("1", "2", "3"), page))).toEqual([]);
  });

  it("NEVER drops off-page ids — whoever clicked them clicked them on purpose", () => {
    // Selecting the page: the off-page ones stay.
    expect(sorted(applyToggleAllVisible(set("off-1"), page))).toEqual(["1", "2", "3", "off-1"]);
    // Clearing the page: the off-page ones stay TOO.
    expect(sorted(applyToggleAllVisible(set("1", "2", "3", "off-1"), page))).toEqual(["off-1"]);
  });

  it("an empty page is a no-op", () => {
    expect(sorted(applyToggleAllVisible(set("off-1"), []))).toEqual(["off-1"]);
  });
});

describe("countVisibleSelected (a base de \"3 selected (2 not on this page)\")", () => {
  it("counts only what is on the visible page", () => {
    const selected = set("1", "3", "off-1", "off-2");
    const page = ["1", "2", "3"];
    expect(countVisibleSelected(selected, page)).toBe(2);
    // and the difference is exactly what the bar shows in parentheses
    expect(selected.size - countVisibleSelected(selected, page)).toBe(2);
  });

  it("the selection survives the whole page being swapped by the polling", () => {
    const selected = set("10", "11", "12");
    // cycle 1: all three are visible
    expect(countVisibleSelected(selected, ["10", "11", "12", "13"])).toBe(3);
    // cycle 2: the queue moved and all three left the first page
    expect(countVisibleSelected(selected, ["20", "21", "22"])).toBe(0);
    // but they are still selected: nothing was dropped silently
    expect(selected.size).toBe(3);
  });
});
