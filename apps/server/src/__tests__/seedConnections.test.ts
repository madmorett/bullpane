import { describe, expect, it } from "vitest";
import { loadConfig } from "../config";
import { seedConnections } from "../seedConnections";

const quiet = { warn: () => undefined };

describe("BULLPANE_CONNECTIONS", () => {
  it("is empty when unset", () => {
    expect(loadConfig({}, quiet).seedConnections).toEqual([]);
  });

  it("parses a JSON array and applies the schema defaults", () => {
    const cfg = loadConfig(
      { BULLPANE_CONNECTIONS: '[{"name":"Demo","url":"redis://localhost:6379"}]' },
      quiet,
    );
    expect(cfg.seedConnections).toEqual([{ name: "Demo", kind: "redis", url: "redis://localhost:6379", prefix: "bull", cluster: false }]);
  });

  it("seeds a BullMQ Postgres connection with the bullmq schema by default", () => {
    const cfg = loadConfig(
      { BULLPANE_CONNECTIONS: '[{"name":"Jobs","kind":"postgres","url":"postgres://app:pw@db:5432/app"}]' },
      quiet,
    );
    expect(cfg.seedConnections).toEqual([
      { name: "Jobs", kind: "postgres", url: "postgres://app:pw@db:5432/app", prefix: "bullmq", cluster: false },
    ]);
    const mismatched = () => loadConfig({ BULLPANE_CONNECTIONS: '[{"name":"J","kind":"postgres","url":"redis://x"}]' }, quiet);
    expect(mismatched).toThrow(/\[0\]\.url: Must start with postgres:\/\//);
  });

  it("names the bad field and never echoes the URL", () => {
    const secret = "http://user:hunter2@redis:6379";
    const run = () => loadConfig({ BULLPANE_CONNECTIONS: JSON.stringify([{ name: "A", url: secret }]) }, quiet);
    expect(run).toThrow(/BULLPANE_CONNECTIONS\[0\]\.url/);
    expect(run).not.toThrow(/hunter2/);
  });

  it("rejects something that is not an array, and duplicated names", () => {
    expect(() => loadConfig({ BULLPANE_CONNECTIONS: '{"name":"A"}' }, quiet)).toThrow(/JSON array/);
    expect(() => loadConfig({ BULLPANE_CONNECTIONS: "not json" }, quiet)).toThrow(/JSON array/);
    const dup = '[{"name":"A","url":"redis://a"},{"name":"A","url":"redis://b"}]';
    expect(() => loadConfig({ BULLPANE_CONNECTIONS: dup }, quiet)).toThrow(/\[1\]\.name: duplicated/);
  });

  it("creates missing connections only, and logs names without URLs", async () => {
    const existing = new Set(["Kept"]);
    const created: string[] = [];
    const logs: string[] = [];
    const store = {
      findByName: async (name: string) => (existing.has(name) ? ({ name } as never) : null),
      create: async (input: { name: string }) => {
        created.push(input.name);
        existing.add(input.name);
        return input as never;
      },
    };
    const log = { info: (obj: object) => logs.push(JSON.stringify(obj)) };
    const wanted = [
      { name: "Kept", kind: "redis" as const, url: "redis://kept", prefix: "bull", cluster: false },
      { name: "New", kind: "redis" as const, url: "redis://user:pw@new", prefix: "bull", cluster: false },
    ];

    expect(await seedConnections(store, wanted, log)).toBe(1);
    expect(created).toEqual(["New"]);
    expect(logs.join(" ")).not.toMatch(/redis:\/\//);

    // Second boot: nothing to do.
    expect(await seedConnections(store, wanted, log)).toBe(0);
  });
});
