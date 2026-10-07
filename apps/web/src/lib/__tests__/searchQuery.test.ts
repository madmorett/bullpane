import { describe, expect, it } from "vitest";
import { parseSearchQuery } from "../searchQuery";

describe("parseSearchQuery", () => {
  it("keeps plain text as it is", () => {
    expect(parseSearchQuery("  timeout 504 ")).toEqual({ text: "timeout 504" });
  });
  it("takes group:<id> out of the text, anywhere", () => {
    expect(parseSearchQuery("group:tenant-a")).toEqual({ text: "", groupId: "tenant-a" });
    expect(parseSearchQuery('"campaign":7, group:tenant-a')).toEqual({ text: '"campaign":7,', groupId: "tenant-a" });
    expect(parseSearchQuery("retry group:tenant-a later")).toEqual({ text: "retry later", groupId: "tenant-a" });
  });
  it("accepts a quoted id with spaces", () => {
    expect(parseSearchQuery('group:"acme corp" invoice')).toEqual({ text: "invoice", groupId: "acme corp" });
  });
  it("lets the last group: win", () => {
    expect(parseSearchQuery("group:a group:b")).toEqual({ text: "", groupId: "b" });
  });
  it("does not treat a word merely containing group: as the filter", () => {
    expect(parseSearchQuery("subgroup:x")).toEqual({ text: "subgroup:x" });
  });
});
