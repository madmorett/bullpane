/**
 * Samples the stress Redis once a second: ops/s, CPU, memory, clients, blocked,
 * new SLOWLOG entries (>= slowlog-log-slower-than) and LATENCY LATEST. JSONL out.
 */
import { mkdirSync } from "node:fs";
import IORedis from "ioredis";
import { OUT_DIR, appendJsonl, redisOpts } from "./common.js";

const r = new IORedis(redisOpts());
mkdirSync(OUT_DIR, { recursive: true });
const file = `${OUT_DIR}/redis.jsonl`;
let prev: Record<string, number> | null = null;
let lastSlowId = -1;

function parseInfo(raw: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const line of raw.split("\n")) {
    const m = /^(\w+):(-?[\d.]+)\r?$/.exec(line);
    if (m) out[m[1]] = Number(m[2]);
  }
  return out;
}

setInterval(async () => {
  try {
    const info = parseInfo(await r.info());
    const slow = (await r.call("SLOWLOG", "GET", "256")) as Array<[number, number, number, string[], string, string]>;
    const fresh = slow.filter((e) => e[0] > lastSlowId).map((e) => ({ id: e[0], at: e[1], us: e[2], cmd: e[3].slice(0, 2).join(" ").slice(0, 60), client: e[5] }));
    if (slow.length) lastSlowId = Math.max(lastSlowId, ...slow.map((e) => e[0]));
    const latency = (await r.call("LATENCY", "LATEST")) as Array<[string, number, number, number]>;
    const row = {
      t: Date.now(),
      ops: prev ? info.total_commands_processed - prev.total_commands_processed : 0,
      cpuMs: prev ? Math.round(((info.used_cpu_sys - prev.used_cpu_sys) + (info.used_cpu_user - prev.used_cpu_user)) * 1000) : 0,
      memMB: Math.round(info.used_memory / 1048576),
      clients: info.connected_clients,
      blocked: info.blocked_clients,
      evictedKeys: info.evicted_keys,
      slow: fresh,
      latency: latency.map(([event, , latest, max]) => ({ event, latest, max })),
    };
    prev = info;
    appendJsonl(file, row);
    process.stdout.write(`\r[redis] ops/s ${row.ops} cpu ${row.cpuMs}ms/s mem ${row.memMB}MB clients ${row.clients} slow+${fresh.length}   `);
  } catch (e) { console.error("[redis]", (e as Error).message); }
}, 1000);
