/**
 * Smoke test of the Redis path, end to end — the path every 0.5.x install is on:
 *
 *   pnpm smoke:redis
 *
 * The same sections as smoke:postgres (runner.ts): every feature over HTTP
 * with the Pro edition, the browser journey (add a Redis connection through
 * the dialog, read, search, open, remove, pause, retry, health, delete) and
 * the free edition. Real Redis, real BullMQ workers, the real server.
 *
 * Redis: BULLPANE_SMOKE_REDIS_URL, else a throwaway `redis:7-alpine` container
 * started (and removed) here. Every run works under its own key prefixes
 * (`smoke-<random>-*`) and deletes only those keys.
 *
 * Env: SMOKE_SKIP=ui,free · SMOKE_SCREENSHOTS · SMOKE_NO_BUILD=1 · SMOKE_CHROMIUM
 */
import { execFileSync } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { Redis } from "ioredis";
import { heading, info } from "./harness.js";
import { runSuite } from "./runner.js";

async function reachable(url: string): Promise<boolean> {
  const r = new Redis(url, { lazyConnect: true, maxRetriesPerRequest: 1, connectTimeout: 1500, retryStrategy: () => null });
  r.on("error", () => undefined);
  try {
    await r.connect();
    return (await r.ping()) === "PONG";
  } catch {
    return false;
  } finally {
    r.disconnect();
  }
}

async function redis(): Promise<{ url: string; stop: () => void }> {
  const explicit = process.env.BULLPANE_SMOKE_REDIS_URL;
  if (explicit) {
    if (!(await reachable(explicit))) throw new Error(`BULLPANE_SMOKE_REDIS_URL is set but ${explicit} is unreachable`);
    return { url: explicit, stop: () => undefined };
  }
  // No default to localhost:6379 on purpose: that is someone's dev Redis, and
  // the dashboard would list every queue in it next to the smoke's.
  const name = `bullpane-smoke-redis-${process.pid}`;
  info(`starting a throwaway Redis container (${name})`);
  execFileSync("docker", ["run", "-d", "--rm", "--name", name, "-p", "127.0.0.1::6379", "redis:7-alpine"], { stdio: "ignore" });
  const port = execFileSync("docker", ["port", name, "6379/tcp"]).toString().trim().split("\n")[0]!.split(":").pop();
  const url = `redis://127.0.0.1:${port}`;
  for (let i = 0; i < 60 && !(await reachable(url)); i++) await sleep(500);
  return { url, stop: () => execFileSync("docker", ["rm", "-f", name], { stdio: "ignore" }) };
}

async function main(): Promise<number> {
  heading("Setup");
  const r = await redis();
  const run = Math.random().toString(36).slice(2, 8);
  info(`redis ${r.url.replace(/:[^:@/]+@/, ":****@")} · prefixes smoke-${run}-*`);
  try {
    return await runSuite({ base: { kind: "redis", url: r.url }, run });
  } finally {
    r.stop();
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
