#!/usr/bin/env node
/**
 * `npx bullpane` — the dashboard without Docker. Same server as the image,
 * bundled; SQLite in ~/.bullpane unless DATABASE_URL says otherwise.
 *
 * Flags win over environment variables, which win over the defaults below.
 * Every variable the image honours (docs: apps/server/README.md) works here too.
 */
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { version } = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));

const HELP = `Bullpane ${version} — self-hosted dashboard for BullMQ and BullMQ Pro

Usage
  npx bullpane [--redis <url> | --postgres <url>] [options]

Options
  --redis <url>          Redis your BullMQ workers use, added as a connection
                         (e.g. redis://localhost:6379). More can be added in the UI.
  --prefix <prefix>      BullMQ prefix of that connection (default: bull)
  --postgres <url>       Postgres of BullMQ 6's Postgres backend, added as a
                         connection (e.g. postgres://user:pass@localhost:5432/app)
  --schema <schema>      Schema BullMQ created its tables in (default: bullmq)
  --port <port>          HTTP port (default: 3000, or $PORT)
  --host <host>          Interface to listen on (default: 127.0.0.1). The free
                         edition has no login: only use 0.0.0.0 on a private network.
  --data-dir <dir>       Where the SQLite database lives (default: ~/.bullpane)
  --database-url <url>   mysql://user:pass@host:3306/db to use MySQL instead
  --read-only            Refuse every write (retry, remove, pause...) with 423
  -v, --version          Print the version
  -h, --help             Print this help

Docs: https://bullpane.com · Docker: ghcr.io/madmorett/bullpane`;

let args;
try {
  args = parseArgs({
    options: {
      redis: { type: "string" },
      prefix: { type: "string" },
      postgres: { type: "string" },
      schema: { type: "string" },
      port: { type: "string" },
      host: { type: "string" },
      "data-dir": { type: "string" },
      "database-url": { type: "string" },
      "read-only": { type: "boolean" },
      version: { type: "boolean", short: "v" },
      help: { type: "boolean", short: "h" },
    },
    strict: true,
  }).values;
} catch (err) {
  console.error(`${err.message}\n\n${HELP}`);
  process.exit(2);
}

if (args.help) {
  console.log(HELP);
  process.exit(0);
}
if (args.version) {
  console.log(version);
  process.exit(0);
}

const env = process.env;
const set = (key, flag, fallback) => {
  if (flag !== undefined) env[key] = String(flag);
  else if (env[key] === undefined || env[key] === "") {
    if (fallback !== undefined) env[key] = String(fallback);
  }
};

set("PORT", args.port, 3000);
set("HOST", args.host, "127.0.0.1");
set("BULLPANE_DATA_DIR", args["data-dir"], path.join(homedir(), ".bullpane"));
set("DATABASE_URL", args["database-url"]);
set("BULLPANE_READ_ONLY", args["read-only"] ? "true" : undefined);
set("WEB_DIST", undefined, path.join(root, "web"));
set("PUBLIC_URL", undefined, `http://localhost:${env.PORT}`);
set("NODE_ENV", undefined, "production");

if (args.redis && args.postgres) {
  console.error("--redis and --postgres are one connection each: pass one, add the other in the UI");
  process.exit(2);
}

/** host:port, never the password */
const nameFrom = (url) => {
  const u = new URL(url);
  return `${u.hostname}${u.port ? `:${u.port}` : ""}`;
};

if (args.postgres) {
  let name;
  try {
    name = nameFrom(args.postgres);
  } catch {
    console.error(`--postgres must be a URL like postgres://user:pass@localhost:5432/app`);
    process.exit(2);
  }
  env.BULLPANE_CONNECTIONS = JSON.stringify([{ name, kind: "postgres", url: args.postgres, prefix: args.schema ?? "bullmq" }]);
}

if (args.redis) {
  let name = "Redis";
  try {
    const u = new URL(args.redis);
    name = `${u.hostname}${u.port ? `:${u.port}` : ""}`; // never the password
  } catch {
    console.error(`--redis must be a URL like redis://localhost:6379`);
    process.exit(2);
  }
  // Created at boot only when no connection of that name exists yet, so a
  // second run (or edits made in the UI) never duplicates or overwrites it.
  env.BULLPANE_CONNECTIONS = JSON.stringify([{ name, url: args.redis, prefix: args.prefix ?? "bull" }]);
}

await import("../dist/server.mjs");
