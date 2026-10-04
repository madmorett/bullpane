/**
 * The npm package the way a user gets it: `npm pack` the built ./out, install
 * the tarball into an empty directory outside the monorepo, start the bin and
 * check the server answers, migrates its SQLite and serves the UI.
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
} finally {
  rmSync(dir, { recursive: true, force: true });
}
