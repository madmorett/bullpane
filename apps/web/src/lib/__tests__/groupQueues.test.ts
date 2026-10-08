import { describe, expect, it } from "vitest";
import type { QueueSummary, RedisConnection } from "@bullpane/shared";
import { pinFirst, pinnedSection, type QueueEntry, type QueueSection } from "../groupQueues";

const conn = { id: "c1", name: "Redis" } as RedisConnection;
const entry = (name: string): QueueEntry => ({ connection: conn, queue: { name } as QueueSummary });
const section = (id: string, ...names: string[]): QueueSection => ({ id, title: id, kind: "folder", items: names.map(entry) });
const shape = (sections: QueueSection[]) => sections.map((s) => [s.id, s.items.map((e) => e.queue.name)]);

describe("pinFirst", () => {
  const sections = [section("folder:a", "q1", "q2"), section("folder:b", "q3"), section("leftover", "q4")];

  it("leaves sections alone without pins", () => {
    expect(pinFirst(sections, [])).toBe(sections);
  });

  it("collects pinned queues in pin order and removes them elsewhere", () => {
    expect(shape([pinnedSection(sections.flatMap((s) => s.items), ["c1/q4", "gone", "c1/q1"])!])).toEqual([["pinned", ["q4", "q1"]]]);
    expect(pinnedSection(sections.flatMap((s) => s.items), ["gone"])).toBeNull();
    expect(shape(pinFirst(sections, ["c1/q4", "c1/q1"]))).toEqual([
      ["folder:a", ["q2"]],
      ["folder:b", ["q3"]],
    ]);
  });

  it("moves pinned folders up and drops sections left empty", () => {
    expect(shape(pinFirst(sections, ["folder:b", "c1/q3"]))).toEqual([
      ["folder:a", ["q1", "q2"]],
      ["leftover", ["q4"]],
    ]);
    expect(shape(pinFirst(sections, ["folder:b"]))).toEqual([
      ["folder:b", ["q3"]],
      ["folder:a", ["q1", "q2"]],
      ["leftover", ["q4"]],
    ]);
  });
});
