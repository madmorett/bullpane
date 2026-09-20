/**
 * Joins probe.jsonl + redis.jsonl with phases.json ([{name,start,end}] unix ms)
 * and prints one row per phase: add latency percentiles (exact, over every add in
 * the window), add errors, throughput, queue latency, Redis ops/s + CPU + slowlog.
 */
import { readFileSync } from "node:fs";
import { OUT_DIR, percentile } from "./common.js";

type Probe = { t: number; adds: number; addErrors: number; completed: number; addMs: number[]; qlatMs: number[] };
type Red = { t: number; ops: number; cpuMs: number; memMB: number; clients: number; slow: { us: number; cmd: string }[]; latency: { event: string; latest: number; max: number }[] };
const lines = <T,>(f: string): T[] => readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as T);
const probe = lines<Probe>(`${OUT_DIR}/probe.jsonl`), redis = lines<Red>(`${OUT_DIR}/redis.jsonl`);
const phases = JSON.parse(readFileSync(`${OUT_DIR}/phases.json`, "utf8")) as { name: string; start: number; end: number }[];

const rows = phases.map((ph) => {
  const p = probe.filter((r) => r.t >= ph.start && r.t <= ph.end), rd = redis.filter((r) => r.t >= ph.start && r.t <= ph.end);
  const adds = p.flatMap((r) => r.addMs).sort((a, b) => a - b), ql = p.flatMap((r) => r.qlatMs).sort((a, b) => a - b);
  const secs = Math.max(1, p.length);
  const slow = rd.flatMap((r) => r.slow);
  const byCmd: Record<string, { n: number; maxMs: number }> = {};
  for (const s of slow) { const k = s.cmd.split(" ")[0]; byCmd[k] = byCmd[k] ?? { n: 0, maxMs: 0 }; byCmd[k].n++; byCmd[k].maxMs = Math.max(byCmd[k].maxMs, s.us / 1000); }
  return {
    phase: ph.name, secs,
    "adds/s": Math.round(adds.length / secs), addErr: p.reduce((a, r) => a + r.addErrors, 0),
    "add p50": +percentile(adds, 50).toFixed(2), "add p95": +percentile(adds, 95).toFixed(2), "add p99": +percentile(adds, 99).toFixed(2), "add max": +(adds[adds.length - 1] ?? 0).toFixed(1),
    "done/s": Math.round(p.reduce((a, r) => a + r.completed, 0) / secs),
    "qlat p50": percentile(ql, 50), "qlat p99": percentile(ql, 99), "qlat max": ql[ql.length - 1] ?? 0,
    "redis ops/s": Math.round(rd.reduce((a, r) => a + r.ops, 0) / Math.max(1, rd.length)), "redis cpu%": Math.round(rd.reduce((a, r) => a + r.cpuMs, 0) / Math.max(1, rd.length) / 10),
    "mem MB": rd[rd.length - 1]?.memMB ?? 0, slowlog: Object.entries(byCmd).map(([k, v]) => `${k}×${v.n} (max ${v.maxMs.toFixed(0)}ms)`).join(", ") || "-",
    "latency events": [...new Set(rd.flatMap((r) => r.latency.map((l) => `${l.event} max ${l.max}ms`)))].join("; ") || "-",
  };
});
console.table(rows);
