import { describe, expect, it } from "vitest";
import type { DelayedGroupsPage } from "@bullpane/shared";
import { delayedOnlyGroups, mergeDelayedSlices, pageOfRows } from "../groupRows";

const slice = (groups: DelayedGroupsPage["groups"]): DelayedGroupsPage => ({ groups, ungrouped: 0, scanned: 10, total: 20, nextCursor: null });

describe("mergeDelayedSlices", () => {
  it("sums a group across slices, keeps its soonest run and the latest status", () => {
    const merged = mergeDelayedSlices([
      slice([{ id: "a", delayed: 3, nextRunAt: 200, status: null }]),
      slice([
        { id: "a", delayed: 2, nextRunAt: 100, status: "paused" },
        { id: "b", delayed: 1, nextRunAt: 300, status: null },
      ]),
    ]);
    expect(merged.get("a")).toEqual({ delayed: 5, nextRunAt: 100, status: "paused" });
    expect(merged.get("b")).toEqual({ delayed: 1, nextRunAt: 300, status: null });
  });
});

describe("delayedOnlyGroups", () => {
  const counts = mergeDelayedSlices([
    slice([
      { id: "small", delayed: 2, nextRunAt: 1, status: null },
      { id: "big", delayed: 9, nextRunAt: 1, status: null },
      { id: "indexed", delayed: 5, nextRunAt: 1, status: "waiting" },
      { id: "became-indexed", delayed: 7, nextRunAt: 1, status: null },
    ]),
  ]);
  it("keeps the groups Pro does not index, most delayed first", () => {
    expect(delayedOnlyGroups(counts, new Set()).map((g) => g.id)).toEqual(["big", "became-indexed", "small"]);
  });
  it("drops a group the polled table shows as indexed, whatever the scan said", () => {
    expect(delayedOnlyGroups(counts, new Set(["became-indexed"])).map((g) => g.id)).toEqual(["big", "small"]);
  });
});

describe("pageOfRows", () => {
  const extra = Array.from({ length: 30 }, (_, i) => `d${i}`);
  it("shows no delayed-only row while the page is full of indexed groups", () => {
    expect(pageOfRows(extra, { indexedTotal: 60, page: 1, pageSize: 50 })).toEqual({ delayedOnly: [], lastPage: 2 });
  });
  it("fills the page that straddles the boundary, then the next ones", () => {
    expect(pageOfRows(extra, { indexedTotal: 60, page: 2, pageSize: 50 }).delayedOnly).toEqual(extra);
    expect(pageOfRows(extra, { indexedTotal: 45, page: 1, pageSize: 50 }).delayedOnly).toEqual(extra.slice(0, 5));
    expect(pageOfRows(extra, { indexedTotal: 45, page: 2, pageSize: 50 }).delayedOnly).toEqual(extra.slice(5));
  });
  it("pages a long delayed-only list like any other", () => {
    const many = Array.from({ length: 120 }, (_, i) => i);
    expect(pageOfRows(many, { indexedTotal: 0, page: 3, pageSize: 50 })).toEqual({ delayedOnly: many.slice(100), lastPage: 3 });
  });
  it("has one page even when empty", () => {
    expect(pageOfRows([], { indexedTotal: 0, page: 1, pageSize: 50 })).toEqual({ delayedOnly: [], lastPage: 1 });
  });
});
