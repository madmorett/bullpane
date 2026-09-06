import path from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_DATABASE_URL, loadConfig, SERVER_ROOT } from "../config";
import { splitStatements } from "../db/migrate";
import { pageToRange } from "../routes/jobs";

describe("loadConfig", () => {
  it("requires SESSION_SECRET outside demo mode", () => {
    expect(() => loadConfig({}, { warn: () => undefined })).toThrow(/SESSION_SECRET/);
  });

  it("generates a secret in demo mode with a loud warning", () => {
    const warnings: string[] = [];
    const cfg = loadConfig({ DEMO_MODE: "true" }, { warn: (m) => warnings.push(m) });
    expect(cfg.demoMode).toBe(true);
    expect(cfg.sessionSecret.length).toBeGreaterThanOrEqual(32);
    expect(warnings.join(" ")).toMatch(/SESSION_SECRET/);
  });

  it("applies defaults from .env.example", () => {
    const cfg = loadConfig({ SESSION_SECRET: "x".repeat(40) }, { warn: () => undefined });
    expect(cfg.port).toBe(3000);
    expect(cfg.host).toBe("0.0.0.0");
    expect(cfg.publicUrl).toBe("http://localhost:3000");
    expect(cfg.databaseUrl).toBe(DEFAULT_DATABASE_URL);
    expect(cfg.licenseKey).toBeNull();
    expect(cfg.checkoutUrl).toBe("https://bullmq-visualizer.dev/pro");
    expect(cfg.demoRedisUrl).toBe("redis://localhost:6379");
    expect(cfg.demoAdminEmail).toBe("demo@bullmq-visualizer.dev");
    expect(cfg.queueDiscoveryTtl).toBe(30);
    expect(cfg.alertsInterval).toBe(15);
    expect(cfg.jobPreviewBytes).toBe(2048);
    expect(cfg.webDist).toBe(path.resolve(SERVER_ROOT, "../web/dist"));
  });

  it("parses overrides and strips trailing slashes from PUBLIC_URL", () => {
    const cfg = loadConfig(
      {
        SESSION_SECRET: "x".repeat(40),
        PORT: "8080",
        PUBLIC_URL: "https://queues.example.com/",
        BMV_ALERTS_INTERVAL: "5",
        BMV_LICENSE_KEY: "  abc.def  ",
        WEB_DIST: "/srv/web",
      },
      { warn: () => undefined },
    );
    expect(cfg.port).toBe(8080);
    expect(cfg.publicUrl).toBe("https://queues.example.com");
    expect(cfg.alertsInterval).toBe(5);
    expect(cfg.licenseKey).toBe("abc.def");
    expect(cfg.webDist).toBe("/srv/web");
  });

  it("rejects garbage integers", () => {
    expect(() => loadConfig({ SESSION_SECRET: "x".repeat(40), PORT: "abc" }, { warn: () => undefined })).toThrow(/PORT/);
  });
});

describe("splitStatements", () => {
  it("splits on ;\\n, drops comments and blanks", () => {
    const sql = "-- header\nCREATE TABLE a (\n  x INT\n);\n\nCREATE TABLE b (y INT);\n-- trailing\n";
    expect(splitStatements(sql)).toEqual(["CREATE TABLE a (\n  x INT\n)", "CREATE TABLE b (y INT)"]);
  });
});

describe("pageToRange", () => {
  it("converts 1-based pages to inclusive offsets", () => {
    expect(pageToRange(1, 25)).toEqual({ start: 0, end: 24 });
    expect(pageToRange(3, 10)).toEqual({ start: 20, end: 29 });
  });
});
