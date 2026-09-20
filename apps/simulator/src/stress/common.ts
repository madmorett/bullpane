/**
 * Shared bits of the stress harness. Everything here targets a DEDICATED Redis
 * (default redis://localhost:6390) — never the dev or demo one.
 */
import { appendFileSync } from "node:fs";

export const REDIS_URL = process.env.STRESS_REDIS_URL ?? "redis://localhost:6390";
export const PREFIX = process.env.BULL_PREFIX ?? "bull";
export const OUT_DIR = process.env.STRESS_OUT ?? "/tmp/bullpane-stress";

export function redisOpts(): { host: string; port: number } {
  const u = new URL(REDIS_URL);
  return { host: u.hostname, port: Number(u.port || 6379) };
}

export const QUEUES = {
  backlog: "stress.backlog",
  archive: "stress.archive",
  fat: "stress.fat",
  live: "stress.live",
} as const;

/** Deterministic-looking JSON payload of roughly `bytes` bytes. */
export function payload(bytes: number, seed: number): Record<string, unknown> {
  const head = { orderId: `ord_${seed.toString(36)}`, tenant: `tenant-${seed % 97}`, amount: (seed % 100000) / 100, currency: "BRL" };
  const filler = "x".repeat(Math.max(0, bytes - 160));
  return { ...head, blob: filler };
}

export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}

export function appendJsonl(file: string, row: unknown): void {
  appendFileSync(file, JSON.stringify(row) + "\n");
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
