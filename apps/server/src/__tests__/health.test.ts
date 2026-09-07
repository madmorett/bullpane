/**
 * The homepage monitor is what people will stare at while pointing this at a
 * production Redis. If the derived rates lie, the whole trial is worthless,
 * so the rate math and the warning thresholds are tested directly.
 */
import { describe, expect, it, vi } from "vitest";
import { HealthService, buildWarnings } from "../services/health";
import type { RedisServerInfo } from "@bullmq-visualizer/shared";
import type { ConnectionRow } from "../db/schema";

function info(over: Partial<RedisServerInfo> = {}): RedisServerInfo {
  return {
    redisVersion: "7.2.4",
    mode: "standalone",
    uptimeSeconds: 1000,
    connectedClients: 10,
    usedMemoryBytes: 100,
    usedMemoryHuman: "100B",
    maxMemoryBytes: null,
    totalKeys: 5,
    opsPerSec: 1,
    usedMemoryRssBytes: 120,
    usedMemoryPeakBytes: 150,
    memFragmentationRatio: 1.1,
    maxMemoryPolicy: "noeviction",
    cpuSecondsTotal: 10,
    blockedClients: 0,
    totalCommandsProcessed: 1000,
    keyspaceHitRatePct: 99,
    evictedKeys: 0,
    expiredKeys: 0,
    rejectedConnections: 0,
    connectedReplicas: 0,
    persistenceOk: true,
    latencyMs: 1,
    sampledAt: new Date().toISOString(),
    ...over,
  };
}

const row = { id: "c1", name: "Prod", prefix: "bull" } as ConnectionRow;

function serviceWith(infos: RedisServerInfo[]) {
  let i = 0;
  const serverInfo = vi.fn(async () => infos[Math.min(i++, infos.length - 1)] as RedisServerInfo);
  const connections = {
    inspectorFor: () => ({ serverInfo }),
    listRows: async () => [row],
    getRow: async () => row,
  } as never;
  return { service: new HealthService(connections), serverInfo };
}

describe("HealthService rates", () => {
  it("returns null rates on the first sample (nothing to diff against)", async () => {
    const { service } = serviceWith([info()]);
    const h = await service.get(row);
    expect(h.ok).toBe(true);
    expect(h.commandsPerSec).toBeNull();
    expect(h.cpuCores).toBeNull();
    expect(h.history).toHaveLength(1);
  });

  it("derives commands/sec and CPU cores from cumulative counters", async () => {
    vi.useFakeTimers();
    try {
      const { service } = serviceWith([
        info({ totalCommandsProcessed: 1_000, cpuSecondsTotal: 10 }),
        info({ totalCommandsProcessed: 2_000, cpuSecondsTotal: 12.5 }),
      ]);
      await service.get(row);
      vi.advanceTimersByTime(10_000); // 10 s later
      const h = await service.get(row);
      // 1000 more commands over 10 s
      expect(h.commandsPerSec).toBeCloseTo(100, 1);
      // 2.5 CPU-seconds over 10 s = a quarter of a core
      expect(h.cpuCores).toBeCloseTo(0.25, 2);
      expect(h.history).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not report a negative rate when Redis restarts", async () => {
    vi.useFakeTimers();
    try {
      const { service } = serviceWith([
        info({ totalCommandsProcessed: 5_000 }),
        info({ totalCommandsProcessed: 12 }), // counters reset
      ]);
      await service.get(row);
      vi.advanceTimersByTime(5_000);
      const h = await service.get(row);
      expect(h.commandsPerSec).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("shares one INFO between concurrent callers and rate-limits polling", async () => {
    const { service, serverInfo } = serviceWith([info()]);
    await Promise.all([service.get(row), service.get(row), service.get(row)]);
    expect(serverInfo).toHaveBeenCalledTimes(1);
    await service.get(row); // still inside the minimum interval
    expect(serverInfo).toHaveBeenCalledTimes(1);
  });

  it("nunca mostra um aviso em branco quando o erro vem vazio", () => {
    // ioredis às vezes rejeita sem mensagem (socket fechado no meio do INFO)
    for (const empty of ["", "   "]) {
      const w = buildWarnings(null, empty, null);
      expect(w[0]?.code).toBe("unreachable");
      expect(w[0]?.message.trim()).not.toBe("");
    }
    expect(buildWarnings(null, "ECONNREFUSED", null)[0]?.message).toContain("ECONNREFUSED");
  });

  it("reports a dead Redis instead of throwing", async () => {
    const connections = {
      inspectorFor: () => ({ serverInfo: async () => { throw new Error("ECONNREFUSED"); } }),
      listRows: async () => [row],
      getRow: async () => row,
    } as never;
    const h = await new HealthService(connections).get(row);
    expect(h.ok).toBe(false);
    expect(h.error).toContain("ECONNREFUSED");
    expect(h.warnings.map((w) => w.code)).toContain("unreachable");
  });

  it("computes memory percentage against maxmemory", async () => {
    const { service } = serviceWith([info({ usedMemoryBytes: 800, maxMemoryBytes: 1000 })]);
    const h = await service.get(row);
    expect(h.memoryUsedPct).toBe(80);
  });
});

describe("health warnings", () => {
  it("is quiet when everything is fine", () => {
    expect(buildWarnings(info(), null, 10)).toEqual([]);
  });

  it("escalates memory pressure and calls out noeviction", () => {
    const warn = buildWarnings(info(), null, 80);
    expect(warn[0]).toMatchObject({ level: "warn", code: "memory_high" });
    const crit = buildWarnings(info({ maxMemoryPolicy: "noeviction" }), null, 95);
    expect(crit[0]?.level).toBe("critical");
    expect(crit[0]?.message).toContain("writes will start failing");
  });

  it("treats any eviction on a queue Redis as critical", () => {
    const w = buildWarnings(info({ evictedKeys: 3 }), null, 10);
    expect(w.find((x) => x.code === "eviction")).toMatchObject({ level: "critical" });
  });

  it("flags failed persistence and rejected connections", () => {
    const w = buildWarnings(info({ persistenceOk: false, rejectedConnections: 7 }), null, 10);
    expect(w.map((x) => x.code)).toEqual(expect.arrayContaining(["persistence_failed", "rejected_connections"]));
  });

  it("only flags fragmentation on a meaningfully sized instance", () => {
    expect(buildWarnings(info({ memFragmentationRatio: 2.0, usedMemoryBytes: 1024 }), null, 10)).toEqual([]);
    const big = buildWarnings(info({ memFragmentationRatio: 2.0, usedMemoryBytes: 500 * 1024 * 1024 }), null, 10);
    expect(big.map((x) => x.code)).toContain("fragmentation");
  });

  it("flags a slow INFO round trip", () => {
    const w = buildWarnings(info({ latencyMs: 400 }), null, 10);
    expect(w.map((x) => x.code)).toContain("latency_high");
  });
});
