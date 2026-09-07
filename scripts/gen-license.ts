#!/usr/bin/env tsx
/**
 * Vendor-side licensing tool for Bullpane Pro.
 *
 *   tsx scripts/gen-license.ts keygen [--out keys]
 *   tsx scripts/gen-license.ts sign --licensee "Acme" --email a@b.c [--expires 2027-01-01] [--notes "1.x"] [--key keys/license-private.pem]
 *   tsx scripts/gen-license.ts verify <key> [--pub keys/license-public.pem]
 *
 * License format: base64url(payloadJson).base64url(signature)
 *   payload   = { licensee, email, plan: "pro", issuedAt, expiresAt: number|null, notes? }  (LicensePayload in packages/shared)
 *   signature = Ed25519 over the *base64url payload string* (crypto.sign(null, Buffer.from(payloadB64url), privateKey))
 *
 * The public key (base64 DER / spki) is compiled into the server as LICENSE_PUBLIC_KEY_B64.
 * Validation is offline; nothing phones home. Only node:crypto and node:util are used.
 */
import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";

interface LicensePayload {
  licensee: string;
  email: string;
  plan: "pro";
  issuedAt: number;
  expiresAt: number | null;
  notes?: string;
}

const DEFAULT_PRIVATE = "keys/license-private.pem";
const DEFAULT_PUBLIC = "keys/license-public.pem";

function b64url(buf: Buffer): string {
  return buf.toString("base64url");
}

function usage(code = 1): never {
  console.error(
    [
      "usage:",
      "  gen-license.ts keygen [--out keys] [--force]",
      '  gen-license.ts sign --licensee "Acme" --email a@b.c [--expires YYYY-MM-DD] [--notes text] [--key keys/license-private.pem]',
      "  gen-license.ts verify <key> [--pub keys/license-public.pem]",
    ].join("\n"),
  );
  process.exit(code);
}

function keygen(argv: string[]): void {
  const { values } = parseArgs({
    args: argv,
    options: { out: { type: "string", default: "keys" }, force: { type: "boolean", default: false } },
  });
  const dir = values.out!;
  const privPath = join(dir, "license-private.pem");
  const pubPath = join(dir, "license-public.pem");
  if (!values.force && (existsSync(privPath) || existsSync(pubPath))) {
    console.error(`refusing to overwrite ${privPath} / ${pubPath} (use --force)`);
    process.exit(1);
  }
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  mkdirSync(dir, { recursive: true });
  writeFileSync(privPath, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
  writeFileSync(pubPath, publicKey.export({ type: "spki", format: "pem" }));
  const spkiB64 = (publicKey.export({ type: "spki", format: "der" }) as Buffer).toString("base64");
  console.log(`private key : ${privPath}  (keep this offline; never commit it)`);
  console.log(`public key  : ${pubPath}`);
  console.log("");
  console.log("Paste into apps/server (LICENSE_PUBLIC_KEY_B64):");
  console.log(spkiB64);
}

function signCmd(argv: string[]): void {
  const { values } = parseArgs({
    args: argv,
    options: {
      licensee: { type: "string" },
      email: { type: "string" },
      expires: { type: "string" },
      notes: { type: "string" },
      key: { type: "string", default: DEFAULT_PRIVATE },
    },
  });
  if (!values.licensee || !values.email) usage();
  let expiresAt: number | null = null;
  if (values.expires) {
    const d = new Date(values.expires);
    if (Number.isNaN(d.getTime())) {
      console.error(`invalid --expires: ${values.expires}`);
      process.exit(1);
    }
    expiresAt = d.getTime();
  }
  const payload: LicensePayload = {
    licensee: values.licensee!,
    email: values.email!,
    plan: "pro",
    issuedAt: Date.now(),
    expiresAt,
    ...(values.notes ? { notes: values.notes } : {}),
  };
  const privateKey = createPrivateKey(readFileSync(values.key!));
  const payloadB64 = b64url(Buffer.from(JSON.stringify(payload)));
  const signature = sign(null, Buffer.from(payloadB64), privateKey);
  console.log(`${payloadB64}.${b64url(signature)}`);
}

function verifyCmd(argv: string[]): void {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { pub: { type: "string", default: DEFAULT_PUBLIC } },
  });
  const key = positionals[0];
  if (!key) usage();
  const parts = key!.split(".");
  if (parts.length !== 2) {
    console.log("invalid");
    process.exit(1);
  }
  const [payloadB64, sigB64] = parts as [string, string];
  const publicKey = createPublicKey(readFileSync(values.pub!));
  const ok = verify(null, Buffer.from(payloadB64), publicKey, Buffer.from(sigB64, "base64url"));
  if (!ok) {
    console.log("invalid");
    process.exit(1);
  }
  let payload: LicensePayload;
  try {
    payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8")) as LicensePayload;
  } catch {
    console.log("invalid");
    process.exit(1);
  }
  const expired = payload.expiresAt !== null && payload.expiresAt < Date.now();
  console.log(JSON.stringify({ ...payload, valid: !expired, expired }, null, 2));
  if (expired) process.exit(2);
}

const [cmd, ...rest] = process.argv.slice(2);
switch (cmd) {
  case "keygen":
    keygen(rest);
    break;
  case "sign":
    signCmd(rest);
    break;
  case "verify":
    verifyCmd(rest);
    break;
  default:
    usage();
}
