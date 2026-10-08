import { describe, expect, it } from "vitest";
import { applyOrder, moveId } from "../sidebarLayout";

describe("applyOrder", () => {
  const id = (s: string) => s;

  it("keeps the default order when nothing was saved", () => {
    expect(applyOrder(["a", "b", "c"], id, undefined)).toEqual(["a", "b", "c"]);
  });

  it("puts saved ids first and new ones after, in default order", () => {
    expect(applyOrder(["a", "b", "c", "d"], id, ["c", "a"])).toEqual(["c", "a", "b", "d"]);
  });

  it("ignores saved ids that no longer exist", () => {
    expect(applyOrder(["a", "b"], id, ["gone", "b"])).toEqual(["b", "a"]);
  });
});

describe("moveId", () => {
  it("moves down onto the target's slot", () => {
    expect(moveId(["a", "b", "c"], "a", "c")).toEqual(["b", "c", "a"]);
  });

  it("moves up onto the target's slot", () => {
    expect(moveId(["a", "b", "c"], "c", "a")).toEqual(["c", "a", "b"]);
  });

  it("returns the same array for a no-op", () => {
    const ids = ["a", "b"];
    expect(moveId(ids, "a", "a")).toBe(ids);
    expect(moveId(ids, "x", "a")).toBe(ids);
  });
});
