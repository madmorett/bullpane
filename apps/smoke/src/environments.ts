/**
 * The places customers actually run Postgres, each reached by the real server:
 *  - behind PgBouncer in transaction mode, with its defaults (startup options
 *    refused) and with `ignore_startup_parameters=options` (dropped silently);
 *  - over TLS with a private CA, the URL written the way providers hand it out
 *    (`?sslmode=require`), plus verify-full with the CA;
 *  - with a read-only role (USAGE + SELECT): reads work, actions are a clear 403;
 *  - with MySQL as the dashboard's own database instead of SQLite.
 *
 * Everything runs in throwaway containers on a private Docker network, started
 * and removed here. Without Docker the section is skipped, and says so.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import pg from "pg";
import type { JobDetail, JobSearchResult, JobsPage, QueueSummary, RedisConnection } from "@bullpane/shared";
import { Api, startServer, type RunningServer } from "./server.js";
import { assert, check, eq, heading, info } from "./harness.js";
import { resetSchema, seed, SEED } from "./seed.js";

const docker = (...args: string[]) => execFileSync("docker", args, { stdio: ["ignore", "pipe", "pipe"] }).toString().trim();

function dockerAvailable(): boolean {
  try {
    docker("info", "--format", "{{.ServerVersion}}");
    return true;
  } catch {
    return false;
  }
}

function hostPort(container: string, port: number): number {
  return Number(docker("port", container, `${port}/tcp`).split("\n")[0]!.split(":").pop());
}

async function reachable(url: string): Promise<boolean> {
  const c = new pg.Client({ connectionString: url, connectionTimeoutMillis: 1500 });
  try {
    await c.connect();
    await c.end();
    return true;
  } catch {
    return false;
  }
}

async function until(what: string, fn: () => Promise<boolean>, ms = 60_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await fn()) return;
    await sleep(500);
  }
  throw new Error(`timed out waiting for ${what}`);
}

class Containers {
  readonly net: string;
  private readonly names: string[] = [];
  constructor(readonly run: string) {
    this.net = `bullpane-smoke-${run}`;
    docker("network", "create", this.net);
  }
  start(name: string, args: string[], image: string, cmd: string[] = []): string {
    const full = `bullpane-smoke-${this.run}-${name}`;
    docker("run", "-d", "--name", full, "--network", this.net, ...args, image, ...cmd);
    this.names.push(full);
    return full;
  }
  create(name: string, args: string[], image: string, cmd: string[] = []): string {
    const full = `bullpane-smoke-${this.run}-${name}`;
    docker("create", "--name", full, "--network", this.net, ...args, image, ...cmd);
    this.names.push(full);
    return full;
  }
  cleanup(): void {
    for (const n of this.names.reverse()) {
      try {
        docker("rm", "-f", n);
      } catch {
        /* already gone */
      }
    }
    try {
      docker("network", "rm", this.net);
    } catch {
      /* in use or gone */
    }
  }
}

/** A CA and a server certificate for "localhost", made with the openssl CLI. */
function makeCerts(): { dir: string; ca: string } {
  const dir = mkdtempSync(path.join(tmpdir(), "bullpane-smoke-tls-"));
  const o = (...args: string[]) => execFileSync("openssl", args, { cwd: dir, stdio: "ignore" });
  o("req", "-new", "-x509", "-days", "2", "-nodes", "-subj", "/CN=bullpane-smoke-ca", "-keyout", "ca.key", "-out", "ca.crt");
  o("req", "-new", "-nodes", "-subj", "/CN=localhost", "-keyout", "server.key", "-out", "server.csr");
  writeFileSync(path.join(dir, "ext.cnf"), "subjectAltName=DNS:localhost,IP:127.0.0.1\n");
  o("x509", "-req", "-in", "server.csr", "-CA", "ca.crt", "-CAkey", "ca.key", "-CAcreateserial", "-days", "2", "-extfile", "ext.cnf", "-out", "server.crt");
  return { dir, ca: path.join(dir, "ca.crt") };
}

/**
 * The journey a person makes, over HTTP, through one connection URL.
 * `seedUrl` is a direct URL to the same database (seeding goes around the pooler).
 */
async function journey(opts: {
  label: string;
  api: Api;
  url: string;
  seedUrl: string;
  schema: string;
  readOnly?: boolean;
  /** runs once the schema exists (e.g. the grants of a read-only role) */
  afterSeed?: () => Promise<void>;
}): Promise<void> {
  const { api, label, schema } = opts;
  const seeded = await check(`${label}: seed real BullMQ data`, async () => {
    await resetSchema(opts.seedUrl, schema);
    const s = await seed(opts.seedUrl, schema);
    await opts.afterSeed?.();
    return s;
  });
  if (!seeded) return;
  let cid = "";
  try {
    await check(`${label}: test connection`, async () => {
      const ping = await api.post<{ ok: boolean; error: string | null }>("/connections/test", { kind: "postgres", url: opts.url, prefix: schema });
      assert(ping.ok, ping.error ?? "not ok");
    });
    await check(`${label}: create the connection`, async () => {
      const c = await api.post<RedisConnection>("/connections", { name: `env-${schema}`, kind: "postgres", url: opts.url, prefix: schema });
      assert(c.status?.ok, JSON.stringify(c.status));
      cid = c.id;
    });
    if (!cid) return;
    const Q = (q: string) => `/connections/${cid}/queues/${q}`;
    await check(`${label}: read counts and a page of jobs`, async () => {
      eq((await api.get<QueueSummary>(Q("orders"))).counts.waiting, SEED.ordersWaiting, "waiting");
      eq((await api.get<JobsPage>(`${Q("emails")}/jobs?state=failed`)).total, SEED.emailsFailed, "failed");
    });
    const hit = await check(`${label}: search the payload`, async () => {
      const r = await api.get<JobSearchResult>(`${Q("orders")}/jobs/search?state=waiting&q=needle-xyz`);
      eq(r.jobs.length, 1, "hits");
      return r.jobs[0]!.id;
    });
    if (opts.readOnly) {
      await check(`${label}: removing is refused with 403 database_permission_denied`, async () => {
        const body = (await api.expect(403, "DELETE", `${Q("orders")}/jobs/${hit}`)) as { error: string; message: string };
        eq(body.error, "database_permission_denied", "error");
        assert(/permission denied/.test(body.message), body.message);
      });
      await check(`${label}: the job is still there`, () => api.get(`${Q("orders")}/jobs/${hit}`));
    } else {
      await check(`${label}: remove the job`, async () => {
        await api.del(`${Q("orders")}/jobs/${hit}`);
        await api.expect(404, "GET", `${Q("orders")}/jobs/${hit}`);
      });
      await check(`${label}: add a job and retry a failed one`, async () => {
        const { id } = await api.post<{ id: string }>(`${Q("orders")}/jobs`, { name: "env", data: { env: label } });
        eq((await api.get<JobDetail>(`${Q("orders")}/jobs/${id}`)).data, { env: label }, "data");
        const failed = await api.get<JobsPage>(`${Q("emails")}/jobs?state=failed&pageSize=1`);
        await api.post(`${Q("emails")}/jobs/${failed.jobs[0]!.id}/retry`, {});
        eq((await api.get<JobDetail>(`${Q("emails")}/jobs/${failed.jobs[0]!.id}`)).state, "waiting", "state after retry");
      });
    }
    await check(`${label}: health card`, async () => {
      const list = await api.get<Array<{ connectionId: string; ok: boolean; info: { backend?: string } | null }>>("/health/connections");
      const h = list.find((x) => x.connectionId === cid);
      assert(h?.ok && h.info?.backend === "postgres", JSON.stringify(h).slice(0, 200));
    });
  } finally {
    if (cid) await api.del(`/connections/${cid}`).catch(() => undefined);
    await seeded.close();
  }
}

export async function runEnvironments(): Promise<void> {
  heading("Environments: PgBouncer, TLS, read-only role, MySQL app database");
  if (!dockerAvailable()) {
    info("Docker is not available: skipped (this section needs to start containers)");
    return;
  }
  const run = Math.random().toString(36).slice(2, 7);
  const c = new Containers(run);
  const certs = makeCerts();
  const servers: RunningServer[] = [];
  try {
    // --- containers ---------------------------------------------------------
    const pgName = c.start("pg", ["--shm-size=256m", "-e", "POSTGRES_PASSWORD=bullpane", "-e", "POSTGRES_DB=bullpane", "-p", "127.0.0.1::5432"], "postgres:16-alpine");
    const bouncer = (name: string, ignore?: string) =>
      c.start(
        name,
        [
          "-p", "127.0.0.1::5432",
          "-e", `DB_HOST=${pgName}`, "-e", "DB_PORT=5432", "-e", "DB_USER=postgres", "-e", "DB_PASSWORD=bullpane", "-e", "DB_NAME=bullpane",
          "-e", "POOL_MODE=transaction", "-e", "AUTH_TYPE=scram-sha-256", "-e", "MAX_CLIENT_CONN=200", "-e", "DEFAULT_POOL_SIZE=20",
          ...(ignore ? ["-e", `IGNORE_STARTUP_PARAMETERS=${ignore}`] : []),
        ],
        "edoburu/pgbouncer:latest",
      );
    const bouncerA = bouncer("pgbouncer-default");
    const bouncerB = bouncer("pgbouncer-ignore", "options,extra_float_digits");
    const tlsName = c.create(
      "pg-tls",
      ["-e", "POSTGRES_PASSWORD=bullpane", "-e", "POSTGRES_DB=bullpane", "-p", "127.0.0.1::5432"],
      "postgres:16-alpine",
      ["sh", "-c", "cp /certs/server.crt /certs/server.key /tmp/ && chown postgres /tmp/server.* && chmod 600 /tmp/server.key && exec docker-entrypoint.sh postgres -c ssl=on -c ssl_cert_file=/tmp/server.crt -c ssl_key_file=/tmp/server.key"],
    );
    const certDir = path.join(certs.dir, "certs");
    execFileSync("mkdir", ["-p", certDir]);
    execFileSync("cp", [path.join(certs.dir, "server.crt"), path.join(certs.dir, "server.key"), certDir]);
    docker("cp", certDir, `${tlsName}:/certs`);
    docker("start", tlsName);
    const mysqlName = c.start("mysql", ["-e", "MYSQL_ROOT_PASSWORD=root", "-e", "MYSQL_DATABASE=bullpane", "-p", "127.0.0.1::3306"], "mysql:8.4");

    const direct = `postgres://postgres:bullpane@127.0.0.1:${hostPort(pgName, 5432)}/bullpane`;
    const viaA = `postgres://postgres:bullpane@127.0.0.1:${hostPort(bouncerA, 5432)}/bullpane`;
    const viaB = `postgres://postgres:bullpane@127.0.0.1:${hostPort(bouncerB, 5432)}/bullpane`;
    const tlsBase = `postgres://postgres:bullpane@localhost:${hostPort(tlsName, 5432)}/bullpane`;
    const mysqlUrl = `mysql://root:root@127.0.0.1:${hostPort(mysqlName, 3306)}/bullpane`;

    const ready = await check("start Postgres, 2 PgBouncers, Postgres with TLS, MySQL (throwaway containers)", async () => {
      await until("Postgres", () => reachable(direct));
      await until("PgBouncer (default)", () => reachable(viaA));
      await until("PgBouncer (ignore options)", () => reachable(viaB));
      await until("Postgres with TLS", () => reachable(`${tlsBase}?sslmode=no-verify`));
      await until("MySQL", async () => {
        try {
          docker("exec", mysqlName, "mysqladmin", "-uroot", "-proot", "--silent", "ping");
          return true;
        } catch {
          return false;
        }
      }, 120_000);
      return true;
    });
    if (!ready) return;

    // A read-only role for the same database.
    const admin = new pg.Client({ connectionString: direct });
    await admin.connect();

    const server = await check("start the server (SQLite app database)", () => startServer({ pro: false }));
    if (!server) return;
    servers.push(server);
    const api = new Api(server.url);

    await journey({ label: "PgBouncer, transaction mode, defaults", api, url: viaA, seedUrl: direct, schema: "env_bouncer_a" });
    await journey({ label: "PgBouncer, ignore_startup_parameters=options", api, url: viaB, seedUrl: direct, schema: "env_bouncer_b" });
    await journey({
      label: "TLS, ?sslmode=require (as providers hand it out)",
      api,
      url: `${tlsBase}?sslmode=require`,
      seedUrl: `${tlsBase}?sslmode=no-verify`,
      schema: "env_tls_require",
    });
    await journey({
      label: "TLS, verify-full with the CA",
      api,
      url: `${tlsBase}?sslmode=verify-full&sslrootcert=${certs.ca}`,
      seedUrl: `${tlsBase}?sslmode=no-verify`,
      schema: "env_tls_full",
    });
    await check("TLS, verify-full without the CA is refused", async () => {
      const ping = await api.post<{ ok: boolean; error: string | null }>("/connections/test", { kind: "postgres", url: `${tlsBase}?sslmode=verify-full`, prefix: "env_tls_full" });
      assert(!ping.ok && /certificate/.test(ping.error ?? ""), JSON.stringify(ping));
    });

    const roSchema = "env_readonly";
    await admin.query("DROP ROLE IF EXISTS smoke_ro");
    await admin.query("CREATE ROLE smoke_ro LOGIN PASSWORD 'ro-pass'");
    await journey({
      label: "read-only role (USAGE + SELECT)",
      api,
      url: direct.replace("postgres:bullpane@", "smoke_ro:ro-pass@"),
      seedUrl: direct,
      schema: roSchema,
      readOnly: true,
      afterSeed: async () => {
        await admin.query(`GRANT USAGE ON SCHEMA ${roSchema} TO smoke_ro`);
        await admin.query(`GRANT SELECT ON ALL TABLES IN SCHEMA ${roSchema} TO smoke_ro`);
      },
    });
    await admin.end();

    // --- MySQL as the dashboard's own database ---------------------------------
    const onMysql = await check("start the server with DATABASE_URL=mysql://… (and it really uses MySQL)", async () => {
      const s = await startServer({ pro: false, env: { DATABASE_URL: mysqlUrl } });
      servers.push(s);
      assert(/database:\s*MySQL/i.test(s.log()), `server log does not say MySQL:\n${s.log().slice(-600)}`);
      return s;
    });
    if (onMysql) {
      await journey({ label: "MySQL app database", api: new Api(onMysql.url), url: direct, seedUrl: direct, schema: "env_mysql_app" });
    }
  } finally {
    for (const s of servers) await s.stop().catch(() => undefined);
    c.cleanup();
    rmSync(certs.dir, { recursive: true, force: true });
  }
}
