/**
 * TLS, the way customers write it. The pure part always runs; the live part
 * needs a Postgres with SSL on and the CA that signed its certificate:
 *
 *   BULLPANE_TEST_PG_TLS_URL=postgres://postgres:bullpane@localhost:5441/bullpane
 *   BULLPANE_TEST_PG_TLS_CA=/path/to/ca.crt
 *
 * (apps/smoke starts one when Docker is available.)
 */
import { describe, expect, it } from "vitest";
import pg from "pg";
import { runMigrations } from "bullmq";
import { nodePgConnectionString, PgInspector } from "../index.js";

describe("nodePgConnectionString: sslmode means what it means in psql", () => {
  it("gives prefer / require / verify-ca libpq semantics", () => {
    for (const mode of ["prefer", "require", "verify-ca"]) {
      expect(new URL(nodePgConnectionString(`postgres://u:p@h/db?sslmode=${mode}`)).searchParams.get("uselibpqcompat")).toBe("true");
    }
  });
  it("leaves everything else alone", () => {
    for (const url of [
      "postgres://u:p@h/db",
      "postgres://u:p@h/db?sslmode=disable",
      "postgres://u:p@h/db?sslmode=verify-full",
      "postgres://u:p@h/db?sslmode=no-verify",
      "postgres://u:p@h/db?sslmode=require&uselibpqcompat=false",
    ]) {
      expect(nodePgConnectionString(url)).toBe(url);
    }
  });
  it("keeps the password and the other parameters intact", () => {
    const out = new URL(nodePgConnectionString("postgres://u:p%40ss@h:6543/db?sslmode=require&application_name=x"));
    expect(out.password).toBe("p%40ss");
    expect(out.port).toBe("6543");
    expect(out.searchParams.get("application_name")).toBe("x");
  });
});

const TLS_URL = process.env.BULLPANE_TEST_PG_TLS_URL;
const TLS_CA = process.env.BULLPANE_TEST_PG_TLS_CA;

describe.skipIf(!TLS_URL || !TLS_CA)("against a Postgres with TLS and a private CA", () => {
  const url = (q: string) => `${TLS_URL}${q}`;

  async function encrypted(q: string): Promise<boolean> {
    const c = new pg.Client({ connectionString: nodePgConnectionString(url(q)) });
    await c.connect();
    const { rows } = await c.query("SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()");
    await c.end();
    return rows[0]?.ssl === true;
  }

  it("connects, encrypted, with the modes people paste from their provider", async () => {
    const c = new pg.Client({ connectionString: nodePgConnectionString(url("?sslmode=require")) });
    await c.connect();
    await runMigrations(c as never, "bullmq");
    await c.end();
    for (const q of ["?sslmode=require", "?sslmode=prefer", `?sslmode=verify-ca&sslrootcert=${TLS_CA}`, `?sslmode=verify-full&sslrootcert=${TLS_CA}`]) {
      const ins = new PgInspector({ id: "tls", kind: "postgres", url: url(q) });
      const ping = await ins.ping();
      await ins.close();
      expect(ping, q).toMatchObject({ ok: true });
      expect(await encrypted(q), q).toBe(true);
    }
  });

  it("verify-full without the CA is refused (it is the mode that promises verification)", async () => {
    const ins = new PgInspector({ id: "tls", kind: "postgres", url: url("?sslmode=verify-full") });
    const ping = await ins.ping();
    await ins.close();
    expect(ping.ok).toBe(false);
    expect(ping.error).toMatch(/certificate/);
  });

  it("writes go through bullmq over the same TLS connection", async () => {
    const ins = new PgInspector({ id: "tls", kind: "postgres", url: url("?sslmode=require") });
    try {
      const { id } = await ins.addJob("tls-q", "x", { over: "tls" });
      expect((await ins.getJob("tls-q", id))?.data).toEqual({ over: "tls" });
      await ins.obliterateQueue("tls-q");
    } finally {
      await ins.close();
    }
  });
});
