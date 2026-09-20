/**
 * Signs a sample perpetual (offline) Pro license with the vendor private key and
 * prints it, so the maintainer can test the Pro edition locally without the
 * license API:
 *
 *   pnpm --filter @bullpane/server license:dev
 *   # then: BULLPANE_LICENSE_KEY=<printed key> pnpm dev   (or paste it in Settings → License)
 *
 * Options: --licensee "Name" --email you@example.com --days 30 (default perpetual)
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { LicensePayload } from "@bullpane/shared";
import { LICENSE_PUBLIC_KEY_B64, signLicense, verifyLicenseKey } from "../src/license";

const here = path.dirname(fileURLToPath(import.meta.url));
const privateKeyPath = process.env.DEV_LICENSE_PRIVATE_KEY ?? path.resolve(here, "../../../keys/license-private.pem");

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

let privateKeyPem: string;
try {
  privateKeyPem = readFileSync(privateKeyPath, "utf8");
} catch {
  console.error(`Vendor private key not found at ${privateKeyPath}.`);
  console.error("Run `pnpm license:keygen` (and put its public key in src/license.ts), or point DEV_LICENSE_PRIVATE_KEY at the key.");
  console.error("Generate one with: node -e \"const c=require('crypto');const k=c.generateKeyPairSync('ed25519');" +
    "require('fs').writeFileSync('keys/dev-license-private.pem',k.privateKey.export({type:'pkcs8',format:'pem'}));" +
    "console.log(k.publicKey.export({type:'spki',format:'der'}).toString('base64'))\"");
  console.error("and put the printed public key in LICENSE_PUBLIC_KEY_B64 (or src/license.ts).");
  process.exit(1);
}

const days = arg("days");
const payload: LicensePayload = {
  licensee: arg("licensee") ?? "Local Developer",
  email: arg("email") ?? "dev@example.com",
  plan: "pro",
  issuedAt: Date.now(),
  expiresAt: days ? Date.now() + Number(days) * 86_400_000 : null,
  notes: "dev license — signed with keys/dev-license-private.pem",
};

const key = signLicense(payload, privateKeyPem);
const check = verifyLicenseKey(key, { publicKeyB64: process.env.LICENSE_PUBLIC_KEY_B64 ?? LICENSE_PUBLIC_KEY_B64 });

console.log("");
console.log("Dev Pro license (" + (payload.expiresAt ? `expires ${new Date(payload.expiresAt).toISOString()}` : "perpetual") + "):");
console.log("");
console.log(key);
console.log("");
console.log(check.valid ? "verifies against the compiled-in public key: OK" : `WARNING: does NOT verify: ${check.reason}`);
console.log("");
console.log("Use it with:  BULLPANE_LICENSE_KEY='" + key + "' pnpm dev");
