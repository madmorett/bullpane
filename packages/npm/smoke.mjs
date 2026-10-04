/**
 * The npm package the way a user gets it: `npm pack` the built ./out, install
 * the tarball into an empty directory outside the monorepo, start the bin and
 * check the server answers, migrates its SQLite and serves the UI.
 *
 * With BULLPANE_NPM_SMOKE_PG_URL set, it also runs `bullpane --postgres <url>`
 * against BullMQ data seeded with the bullmq and pg the package installed, and
 * reads and WRITES through it: a write is bullmq requiring `pg` on its own, the
 * thing a bundle would get wrong.
 *
 *   node build.mjs && node smoke.mjs
 */
import { execSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(here, "out");
const { version } = JSON.parse(readFileSync(path.join(out, "package.json"), "utf8"));
const dir = mkdtempSync(path.join(tmpdir(), "bullpane-npm-"));
const port = 30000 + Math.floor(Math.random() * 20000);

try {
  execSync(`npm pack --pack-destination "${dir}"`, { cwd: out, stdio: "ignore" });
  execSync("npm init -y", { cwd: dir, stdio: "ignore" });
  execSync(`npm install --no-audit --no-fund ./bullpane-${version}.tgz`, { cwd: dir, stdio: "inherit" });
  const bin = path.join(dir, "node_modules/.bin/bullpane");
  const printed = execSync(`"${bin}" --version`).toString().trim();
  if (printed !== version) throw new Error(`--version printed ${printed}, expected ${version}`);

  const env = { ...process.env };
  delete env.DATABASE_URL;
  const child = spawn(bin, ["--port", String(port), "--data-dir", path.join(dir, "data")], { env, stdio: ["ignore", "pipe", "pipe"] });
  let log = "";
  child.stdout.on("data", (d) => (log += d));
  child.stderr.on("data", (d) => (log += d));
  try {
    let health = null;
    for (let i = 0; i < 60 && !health; i++) {
      await new Promise((r) => setTimeout(r, 500));
      health = await fetch(`http://127.0.0.1:${port}/api/health`).then((r) => r.json()).catch(() => null);
    }
    if (health?.version !== version) throw new Error(`health: ${JSON.stringify(health)}\n${log}`);
    const html = await (await fetch(`http://127.0.0.1:${port}/`)).text();
    if (!html.includes("<title>Bullpane")) throw new Error("the UI is not served");
    if (!existsSync(path.join(dir, "data/bullpane.db"))) throw new Error("no SQLite file in --data-dir");
    if (!/listening on 127\.0\.0\.1/.test(log)) throw new Error("does not default to 127.0.0.1");
    console.log(`npm smoke ok: bullpane@${version}`);
  } finally {
    child.kill("SIGTERM");
  }
  if (process.env.BULLPANE_NPM_SMOKE_PG_URL) await postgresSmoke(bin, process.env.BULLPANE_NPM_SMOKE_PG_URL);
} finally {
  rmSync(dir, { recursive: true, force: true });
}

async function postgresSmoke(bin, pgUrl) {
  const req = (await import("node:module")).createRequire(path.join(dir, "package.json"));
  const pg = req("pg");
  const { Queue, createPostgresBackend, runMigrations } = req("bullmq");
  const schema = `npm_smoke_${Math.random().toString(36).slice(2, 7)}`;
  const admin = new pg.Client({ connectionString: pgUrl });
  await admin.connect();
  const pgPort = port + 1;
  try {
    await runMigrations(admin, schema);
    const q = new Queue("orders", { connection: { connectionString: pgUrl, schema } }, createPostgresBackend);
    for (let i = 0; i < 3; i++) await q.add("order", { i });
    await q.close();

    const env = { ...process.env };
    delete env.DATABASE_URL;
    const child = spawn(bin, ["--port", String(pgPort), "--data-dir", path.join(dir, "data-pg"), "--postgres", pgUrl, "--schema", schema], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let log = "";
    child.stdout.on("data", (d) => (log += d));
    child.stderr.on("data", (d) => (log += d));
    const api = (p, init) => fetch(`http://127.0.0.1:${pgPort}/api${p}`, init).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));
    try {
      let conns = null;
      for (let i = 0; i < 60 && !conns?.length; i++) {
        await new Promise((r) => setTimeout(r, 500));
        conns = await api("/connections").then((r) => r.body).catch(() => null);
      }
      const c = conns?.[0];
      if (!c || c.kind !== "postgres" || !c.status?.ok) throw new Error(`postgres connection: ${JSON.stringify(c)}\n${log}`);
      const queue = await api(`/connections/${c.id}/queues/orders`);
      if (queue.body?.counts?.waiting !== 3) throw new Error(`read: ${JSON.stringify(queue.body)}`);
      const added = await api(`/connections/${c.id}/queues/orders/jobs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "from-npx", data: { ok: true } }),
      });
      if (added.status !== 201 && added.status !== 200) throw new Error(`write (bullmq + pg from the package): ${added.status} ${JSON.stringify(added.body)}\n${log}`);
      const removed = await api(`/connections/${c.id}/queues/orders/jobs/${added.body.id}`, { method: "DELETE" });
      if (removed.status !== 200) throw new Error(`remove: ${removed.status} ${JSON.stringify(removed.body)}`);
      console.log(`npm smoke ok: bullpane@${version} --postgres (read, write, remove)`);
    } finally {
      child.kill("SIGTERM");
    }
  } finally {
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => undefined);
    await admin.end();
  }
}
