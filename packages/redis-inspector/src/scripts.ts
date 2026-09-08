/**
 * Loads the Lua scripts from disk once and registers them on an ioredis client
 * with `defineCommand`. ioredis then issues EVALSHA (falling back to EVAL only on
 * NOSCRIPT), so every read is exactly one round trip and the script body is sent
 * to Redis once per connection.
 *
 * Adding a script: drop `lua/foo.lua` in, add an entry to SCRIPTS with its fixed
 * number of KEYS, and call `client.foo(...)` / `pipeline.foo(...)` via `callScript`.
 */
import { readFileSync } from "node:fs";
import type { Cluster, Redis } from "ioredis";
import type { ChainableCommander } from "ioredis";
import type { LuaReply } from "./parse.js";

export type RedisClient = Redis | Cluster;

export const SCRIPTS = {
  /** 8 state keys + meta + groups + metrics (4) + repeat + stalled */
  queueStats: { numberOfKeys: 16, readOnly: true },
  /** the state list/zset, or a Pro group's list + its `:p` zset -> numberOfKeys passed at call time */
  getJobs: { numberOfKeys: undefined, readOnly: true },
  getJobsSearch: { numberOfKeys: 1, readOnly: true, file: "searchJobs" },
  /** hash, logs, dependencies, processed + 8 state keys */
  getJob: { numberOfKeys: 12, readOnly: true },
  /** variable number of state keys -> numberOfKeys passed at call time */
  sampleParents: { numberOfKeys: undefined, readOnly: true },
  /** groups, groups:limit, groups:max, groups:paused, groups:active:count, groups:concurrency */
  getGroups: { numberOfKeys: 6, readOnly: true },
  /** the `repeat` zset (job schedulers); the per-scheduler hashes are built inside Lua */
  getSchedulers: { numberOfKeys: 1, readOnly: true },
  /** meta, limiter, groups, groups:limit, groups:max, groups:paused, groups:active:count, groups:metas, metrics:completed */
  queueSetup: { numberOfKeys: 9, readOnly: true },
} as const;

export type ScriptName = keyof typeof SCRIPTS;

const luaCache = new Map<string, string>();

function loadLua(file: string): string {
  const cached = luaCache.get(file);
  if (cached) return cached;
  // Resolved relative to this module so it works from source (tsx/vitest) and from any cwd.
  const src = readFileSync(new URL(`./lua/${file}.lua`, import.meta.url), "utf8");
  luaCache.set(file, src);
  return src;
}

/** Register every script on a client (Redis or Cluster). Idempotent per client. */
export function defineScripts(client: RedisClient): void {
  for (const [name, def] of Object.entries(SCRIPTS)) {
    const file = "file" in def ? def.file : name;
    client.defineCommand(name, {
      lua: loadLua(file),
      numberOfKeys: def.numberOfKeys,
      readOnly: def.readOnly,
    });
  }
}

type ScriptArg = string | number;
type ScriptFn = (...args: ScriptArg[]) => Promise<LuaReply>;
type PipelineScriptFn = (...args: ScriptArg[]) => ChainableCommander;

/**
 * Invoke a defined script on a client. ioredis adds the method dynamically, so we
 * go through a narrow cast here instead of leaking `any` into the inspector.
 * When `numberOfKeys` is undefined for the script, the first arg must be the key count.
 */
export function callScript(client: RedisClient, name: ScriptName, args: ScriptArg[]): Promise<LuaReply> {
  const fn = (client as unknown as Record<string, ScriptFn>)[name];
  return fn.call(client, ...args);
}

/** Same as callScript but queued on a pipeline. */
export function pipelineScript(pipeline: ChainableCommander, name: ScriptName, args: ScriptArg[]): void {
  const fn = (pipeline as unknown as Record<string, PipelineScriptFn>)[name];
  fn.call(pipeline, ...args);
}
