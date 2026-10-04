/**
 * Assembles the publishable `bullpane` npm package in ./out:
 *
 *   out/package.json      generated: name, version (from the root), bin, and the
 *                         third-party dependencies of server + inspector + shared
 *   out/bin/bullpane.mjs  the CLI
 *   out/dist/server.mjs   apps/server bundled with the workspace packages
 *   out/dist/lua/         the inspector's scripts (loaded relative to the bundle)
 *   out/migrations/       read relative to the package root, like in the repo
 *   out/web/              the built UI
 *
 * Third-party packages stay external: npm installs them, including libsql's
 * prebuilt native binary for the user's platform. The paths the server
 * resolves at runtime (SERVER_ROOT = dist/.., lua next to the bundle) line up
 * with the repo layout on purpose, so no server code knows about this package.
 *
 *   node build.mjs            build (runs the web build first)
 *   node build.mjs --no-web   reuse apps/web/dist
 */
import { execSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "../..");
const out = path.join(here, "out");
const read = (p) => JSON.parse(readFileSync(path.join(repo, p), "utf8"));

if (!process.argv.includes("--no-web")) {
  execSync("pnpm --filter @bullpane/web build", { cwd: repo, stdio: "inherit" });
}
if (!existsSync(path.join(repo, "apps/web/dist/index.html"))) throw new Error("apps/web/dist is missing: build the web first");

const root = read("package.json");
const manifests = ["apps/server/package.json", "packages/redis-inspector/package.json", "packages/shared/package.json"].map(read);
const dependencies = {};
for (const m of manifests) {
  for (const [name, range] of Object.entries(m.dependencies ?? {})) {
    if (String(range).startsWith("workspace:")) continue;
    if (dependencies[name] && dependencies[name] !== range) throw new Error(`${name}: ${dependencies[name]} vs ${range}`);
    dependencies[name] = range;
  }
}
// The server imports bullmq at runtime through the inspector; it is a devDependency
// of apps/server only because the inspector already declares it.
for (const m of manifests) if (m.dependencies?.bullmq) dependencies.bullmq = m.dependencies.bullmq;

rmSync(out, { recursive: true, force: true });
mkdirSync(path.join(out, "dist"), { recursive: true });

await build({
  entryPoints: [path.join(repo, "apps/server/src/index.ts")],
  outfile: path.join(out, "dist/server.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  external: Object.keys(dependencies),
  sourcemap: false,
  legalComments: "inline",
  logLevel: "warning",
});

cpSync(path.join(repo, "packages/redis-inspector/src/lua"), path.join(out, "dist/lua"), { recursive: true });
cpSync(path.join(repo, "apps/server/migrations"), path.join(out, "migrations"), { recursive: true });
cpSync(path.join(repo, "apps/web/dist"), path.join(out, "web"), { recursive: true });
cpSync(path.join(here, "bin"), path.join(out, "bin"), { recursive: true });
cpSync(path.join(here, "README.md"), path.join(out, "README.md"));
cpSync(path.join(repo, "LICENSE"), path.join(out, "LICENSE"));
if (existsSync(path.join(repo, "apps/server/src/ee/LICENSE"))) cpSync(path.join(repo, "apps/server/src/ee/LICENSE"), path.join(out, "LICENSE-ee"));

const pkg = {
  name: "bullpane",
  version: root.version,
  description:
    "Self-hosted dashboard for BullMQ and BullMQ Pro: queues, jobs, failures, metrics, Redis health, flows and Pro groups. A bull-board alternative you can run with npx.",
  keywords: ["bullmq", "bullmq-pro", "bull", "dashboard", "ui", "queue", "redis", "jobs", "monitoring", "bull-board", "admin", "self-hosted"],
  homepage: "https://bullpane.com",
  repository: { type: "git", url: "git+https://github.com/madmorett/bullpane.git" },
  bugs: "https://github.com/madmorett/bullpane/issues",
  license: "SEE LICENSE IN LICENSE",
  type: "module",
  bin: { bullpane: "bin/bullpane.mjs" },
  files: ["bin", "dist", "migrations", "web", "README.md", "LICENSE", "LICENSE-ee"],
  engines: { node: ">=20" },
  dependencies: Object.fromEntries(Object.entries(dependencies).sort(([a], [b]) => a.localeCompare(b))),
};
writeFileSync(path.join(out, "package.json"), `${JSON.stringify(pkg, null, 2)}\n`);
console.log(`built bullpane@${pkg.version} in ${path.relative(repo, out)}`);
