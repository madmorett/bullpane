/**
 * SAML 2.0 (HTTP-Redirect out, HTTP-POST back), wrapping @node-saml/node-saml.
 *
 * WHY A LIBRARY HERE AND NOT FOR OIDC: an OIDC id_token is a JWS — one
 * signature over one base64 string. A SAML assertion is signed XML, where
 * correctness means XML canonicalisation, reference resolution and defending
 * against signature-wrapping attacks. Hand-rolling that is how CVEs happen.
 *
 * WHAT THIS WRAPPER ENFORCES, so no caller can weaken it:
 *  - `wantAssertionsSigned: true` — an unsigned assertion is a login form the
 *    whole internet can fill in.
 *  - `audience` pinned to our entity id — otherwise an assertion minted for a
 *    different SP at the same IdP is accepted here.
 *  - `validateInResponseTo: always` with a real cache — this is the SAML replay
 *    defence, equivalent to the OIDC nonce check.
 */
import { SAML, ValidateInResponseTo, type Profile } from "@node-saml/node-saml";
import type { SsoSamlConfig } from "@bullpane/shared";

export class SamlError extends Error {
  constructor(
    message: string,
    readonly publicMessage = message,
  ) {
    super(message);
    this.name = "SamlError";
  }
}

/**
 * IdPs hand out certificates in every shape: PEM with headers, bare base64,
 * with or without line wrapping. node-saml wants the body without headers.
 */
export function normaliseCert(cert: string): string {
  const stripped = cert
    .replace(/-----BEGIN CERTIFICATE-----/g, "")
    .replace(/-----END CERTIFICATE-----/g, "")
    .replace(/\s+/g, "");
  if (stripped.length === 0) throw new SamlError("empty certificate", "The IdP signing certificate is empty.");
  if (!/^[A-Za-z0-9+/=]+$/.test(stripped)) {
    throw new SamlError("certificate is not base64", "The IdP signing certificate is not valid base64/PEM.");
  }
  return stripped;
}

/**
 * In-memory store for the request ids we issued, so a response can be matched
 * to a request we actually started (InResponseTo). TTL-bounded and capped:
 * a login flow lasts seconds, and an unbounded map is a memory leak an
 * attacker can drive by hammering /start.
 */
export class RequestIdCache {
  private readonly items = new Map<string, number>();

  constructor(
    private readonly ttlMs = 10 * 60 * 1000,
    private readonly maxEntries = 5000,
  ) {}

  private sweep(now: number): void {
    for (const [key, createdAt] of this.items) {
      if (createdAt + this.ttlMs < now) this.items.delete(key);
    }
  }

  async saveAsync(key: string, value: string): Promise<{ value: string; createdAt: number } | null> {
    const now = Date.now();
    this.sweep(now);
    if (this.items.size >= this.maxEntries) return null;
    if (this.items.has(key)) return null;
    this.items.set(key, now);
    return { value, createdAt: now };
  }

  async getAsync(key: string): Promise<string | null> {
    const createdAt = this.items.get(key);
    if (createdAt === undefined) return null;
    if (createdAt + this.ttlMs < Date.now()) {
      this.items.delete(key);
      return null;
    }
    return key;
  }

  /** Called by node-saml once a response is accepted: single use, no replay. */
  async removeAsync(key: string | null): Promise<string | null> {
    if (key === null) return null;
    return this.items.delete(key) ? key : null;
  }

  get size(): number {
    return this.items.size;
  }
}

export interface SamlInstanceArgs {
  config: SsoSamlConfig;
  callbackUrl: string;
  /** Our SP entity id, which the IdP must name as the assertion audience. */
  entityId: string;
  cache: RequestIdCache;
}

export function createSaml(args: SamlInstanceArgs): SAML {
  return new SAML({
    entryPoint: args.config.entryPoint,
    // `issuer` in node-saml means the SP (us), not the IdP.
    issuer: args.entityId,
    callbackUrl: args.callbackUrl,
    idpCert: normaliseCert(args.config.idpCert),
    // Non-negotiables. See the file header.
    wantAssertionsSigned: true,
    audience: args.entityId,
    validateInResponseTo: ValidateInResponseTo.always,
    cacheProvider: args.cache,
    signatureAlgorithm: "sha256",
    digestAlgorithm: "sha256",
    identifierFormat: "urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress",
    // We sign no request (no SP private key to manage), so this must be off.
    wantAuthnResponseSigned: false,
    disableRequestedAuthnContext: true,
    acceptedClockSkewMs: 120000,
  });
}

/**
 * Pulls the email out of an assertion. Order matters: the attribute the admin
 * configured wins, then the conventional claim URIs, then NameID — which is an
 * email in the format we request, and is the only field SAML guarantees.
 */
export function emailFromProfile(profile: Profile, configuredAttribute: string): string | null {
  const candidates = [
    configuredAttribute,
    "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress",
    "urn:oid:0.9.2342.19200300.100.1.3",
    "email",
    "mail",
  ];
  for (const key of candidates) {
    const value = profile[key];
    if (typeof value === "string" && value.includes("@")) return value;
    // Some IdPs send multi-valued attributes as arrays.
    if (Array.isArray(value)) {
      const first = value.find((v) => typeof v === "string" && v.includes("@"));
      if (typeof first === "string") return first;
    }
  }
  if (typeof profile.nameID === "string" && profile.nameID.includes("@")) return profile.nameID;
  return null;
}

export function nameFromProfile(profile: Profile): string | null {
  for (const key of [
    "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name",
    "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/givenname",
    "displayName",
    "name",
  ]) {
    const value = profile[key];
    if (typeof value === "string" && value.trim() !== "") return value;
  }
  return null;
}
