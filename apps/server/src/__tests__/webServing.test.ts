/**
 * The built UI is served by @fastify/static plus an SPA fallback in app.ts.
 * Nothing else exercised it, so a major bump of the plugin could ship a blank
 * page. A fake dist (index.html + one hashed asset) is enough to pin the
 * contract: files with cache headers, deep links → index.html without cache,
 * HEAD, and /api never falling back to the page.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { buildApp } from "../app";
import { loadConfig } from "../config";
import type { Db } from "../db";

let dir: string;
let app: FastifyInstance;

beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "bullpane-web-"));
  mkdirSync(path.join(dir, "assets"));
  writeFileSync(path.join(dir, "index.html"), "<!doctype html><title>Bullpane</title><div id=root></div>");
  writeFileSync(path.join(dir, "assets", "app-abc123.js"), "console.log('bullpane')");
  const config = loadConfig({ SESSION_SECRET: "s".repeat(40), WEB_DIST: dir, DEMO_MODE: "false" }, { warn: () => undefined });
  const pool = { get: () => ({}), evict: vi.fn(), closeAll: vi.fn() } as never;
  app = await buildApp({ config, db: {} as Db, pool, logger: false });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("serving the built UI", () => {
  it("serves index.html at /", async () => {
    const res = await app.inject({ method: "GET", url: "/" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/html/);
    expect(res.body).toContain("<title>Bullpane</title>");
    // index.html names the hashed bundles of THIS version. Cached, it outlives
    // an upgrade and asks for bundles that no longer exist: a blank page.
    expect(res.headers["cache-control"]).toBe("no-cache");
  });

  it("serves /index.html uncached too", async () => {
    const res = await app.inject({ method: "GET", url: "/index.html" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-cache");
  });

  it("serves an asset with its type and a cache header", async () => {
    const res = await app.inject({ method: "GET", url: "/assets/app-abc123.js" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toMatch(/javascript/);
    expect(res.headers["cache-control"]).toMatch(/max-age=3600/);
    expect(res.body).toContain("bullpane");
  });

  it("answers a deep link with index.html, never cached", async () => {
    const res = await app.inject({ method: "GET", url: "/c/conn-1/q/payments?state=failed" });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("<title>Bullpane</title>");
    expect(res.headers["cache-control"]).toBe("no-cache");
  });

  it("answers HEAD on a deep link", async () => {
    const res = await app.inject({ method: "HEAD", url: "/settings/license" });
    expect(res.statusCode).toBe(200);
  });

  it("keeps unknown /api routes as JSON 404, not the page", async () => {
    const res = await app.inject({ method: "GET", url: "/api/does-not-exist" });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: "not_found" });
  });

  it("does not serve files outside the dist directory", async () => {
    const res = await app.inject({ method: "GET", url: "/../package.json" });
    expect(res.body).not.toContain('"name"');
  });
});
