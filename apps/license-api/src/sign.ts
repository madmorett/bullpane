/**
 * Ed25519 signing with WebCrypto, producing the exact token format the server
 * verifies: base64url(payloadJson) + "." + base64url(signature), where the
 * signature covers the ASCII bytes of the base64url payload string.
 */
import type { LicensePayload } from "@bullmq-visualizer/shared";

function b64url(bytes: ArrayBuffer | Uint8Array): string {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let bin = "";
  for (const b of arr) bin += String.fromCharCode(b);
  return btoa(bin).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function pemToDer(pem: string): ArrayBuffer {
  const body = pem
    .replace(/-----BEGIN [^-]+-----/g, "")
    .replace(/-----END [^-]+-----/g, "")
    .replace(/\s+/g, "");
  const bin = atob(body);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer as ArrayBuffer;
}

export async function importPrivateKey(pem: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("pkcs8", pemToDer(pem), { name: "Ed25519" }, false, ["sign"]);
}

export async function signLease(payload: LicensePayload, key: CryptoKey): Promise<string> {
  const payloadB64 = b64url(new TextEncoder().encode(JSON.stringify(payload)));
  const signature = await crypto.subtle.sign({ name: "Ed25519" }, key, new TextEncoder().encode(payloadB64).buffer as ArrayBuffer);
  return `${payloadB64}.${b64url(signature)}`;
}
