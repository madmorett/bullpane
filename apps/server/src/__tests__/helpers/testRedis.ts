/**
 * The Redis a suite talks to: BULLPANE_TEST_REDIS_URL when set (CI or a developer's
 * own Redis), otherwise a throwaway `redis-server` on a port of the suite's own,
 * started before and shut down after, as packages/redis-inspector does. So
 * `pnpm test` passes on a clean machine without a Redis already on 6379.
 *
 * Each suite passes its own port: vitest runs files in parallel, and
 * packages/redis-inspector owns 6399.
 */
import { execSync } from "node:child_process";

export interface TestRedis {
  url: string;
  start(): Promise<void>;
  stop(): void;
}

export function testRedis(port: number): TestRedis {
  const external = process.env.BULLPANE_TEST_REDIS_URL;
  const cli = (args: string): string => execSync(`redis-cli -p ${port} ${args}`, { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
  const shutdown = (): void => {
    try {
      cli("shutdown nosave");
    } catch {
      /* not running */
    }
  };
  return {
    url: external ?? `redis://127.0.0.1:${port}`,
    async start() {
      if (external) return;
      shutdown(); // a stale instance from an aborted run
      execSync(`redis-server --port ${port} --save "" --appendonly no --daemonize yes`, { stdio: "ignore" });
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        try {
          if (cli("ping") === "PONG") return;
        } catch {
          /* not up yet */
        }
        await new Promise((r) => setTimeout(r, 50));
      }
      throw new Error(`redis-server did not start on :${port}`);
    },
    stop() {
      if (!external) shutdown();
    },
  };
}
