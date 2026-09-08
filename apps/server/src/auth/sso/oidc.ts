/**
 * OIDC authorization-code flow with PKCE.
 *
 * WHY NO LIBRARY: the flow we need is three fetches and one signature check.
 * `openid-client` would add a dependency tree to a self-hosted binary that
 * customers audit, and the parts that are actually easy to get wrong (nonce
 * binding, `aud`/`iss` checks, PKCE) are the parts we have to understand
 * ourselves anyway. Signature verification is done with node:crypto against
 * the IdP's JWKS.
 *
 * WHAT IS VALIDATED on the id_token, and why each one matters:
 *  - signature (RS256/ES256) against the JWKS key named by `kid`
 *  - `iss` equals the discovered issuer — otherwise any IdP can mint tokens
 *  - `aud` contains our client_id — otherwise a token issued for a DIFFERENT
 *    app at the same IdP logs somebody in here (the classic confused-deputy)
 *  - `nonce` equals the one we put in the signed cookie — replay protection
 *  - `exp`/`iat` within a small clock skew
 * A token missing any of these is refused. There is no "lenient" mode.
 */
import { createHash, createPublicKey, createVerify, randomBytes } from "node:crypto";
import { DEFAULT_OIDC_EMAIL_CLAIM, DEFAULT_OIDC_SCOPES, type SsoOidcConfig } from "@bullpane/shared";

/** Tolerated clock difference between us and the IdP. */
export const CLOCK_SKEW_SECONDS = 120;
const FETCH_TIMEOUT_MS = 8000;

export class OidcError extends Error {
  constructor(
    message: string,
    /** Safe to show the admin/user; never contains the client secret. */
    readonly publicMessage = message,
  ) {
    super(message);
    this.name = "OidcError";
  }
}

export interface OidcDiscovery {
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  jwksUri: string;
  /** Present when the IdP advertises it; we do not require userinfo. */
  userinfoEndpoint: string | null;
}

interface JwksKey {
  kid?: string;
  kty: string;
  alg?: string;
  use?: string;
  n?: string;
  e?: string;
  crv?: string;
  x?: string;
  y?: string;
}

/**
 * A dashboard must never hang because a customer's IdP is down: every outbound
 * call is bounded, and a timeout becomes a readable error, not a stuck request.
 */
async function fetchJson(url: string, init?: RequestInit): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal, redirect: "error" });
    const text = await res.text();
    if (!res.ok) {
      /**
       * The body of a failed token exchange can echo request parameters, so it
       * is logged/propagated only as a truncated string and never wholesale.
       */
      throw new OidcError(`${url} responded ${res.status}: ${text.slice(0, 200)}`, `The identity provider responded ${res.status}.`);
    }
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new OidcError(`${url} did not return JSON`, "The identity provider returned a malformed response.");
    }
  } catch (err) {
    if (err instanceof OidcError) throw err;
    if (err instanceof Error && err.name === "AbortError") {
      throw new OidcError(`${url} timed out`, "The identity provider did not respond in time.");
    }
    throw new OidcError(`${url} failed: ${String(err)}`, "Could not reach the identity provider.");
  } finally {
    clearTimeout(timer);
  }
}

function str(obj: Record<string, unknown>, key: string): string | null {
  const v = obj[key];
  return typeof v === "string" && v.length > 0 ? v : null;
}

/** `${issuer}/.well-known/openid-configuration`, tolerating a trailing slash. */
export function discoveryUrl(issuer: string): string {
  return `${issuer.replace(/\/+$/, "")}/.well-known/openid-configuration`;
}

export async function discover(issuer: string): Promise<OidcDiscovery> {
  const doc = (await fetchJson(discoveryUrl(issuer))) as Record<string, unknown>;
  const resolvedIssuer = str(doc, "issuer");
  const authorizationEndpoint = str(doc, "authorization_endpoint");
  const tokenEndpoint = str(doc, "token_endpoint");
  const jwksUri = str(doc, "jwks_uri");
  if (!resolvedIssuer || !authorizationEndpoint || !tokenEndpoint || !jwksUri) {
    throw new OidcError(
      "discovery document is missing required endpoints",
      "That issuer's discovery document is missing required endpoints (issuer, authorization_endpoint, token_endpoint, jwks_uri).",
    );
  }
  /**
   * The issuer in the document is authoritative (some IdPs are reached at a
   * different host than they claim), and it is what `iss` will be compared to.
   * A mismatch with what the admin typed is normal for e.g. Google; a mismatch
   * on the *token* is not.
   */
  return {
    issuer: resolvedIssuer,
    authorizationEndpoint,
    tokenEndpoint,
    jwksUri,
    userinfoEndpoint: str(doc, "userinfo_endpoint"),
  };
}

export interface PkcePair {
  verifier: string;
  challenge: string;
}

/** RFC 7636 S256. The verifier stays in a signed cookie; only the hash travels. */
export function createPkce(): PkcePair {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

export function randomToken(): string {
  return randomBytes(32).toString("base64url");
}

export function authorizationUrl(args: {
  discovery: OidcDiscovery;
  config: SsoOidcConfig;
  redirectUri: string;
  state: string;
  nonce: string;
  challenge: string;
}): string {
  const scopes = args.config.scopes?.length ? args.config.scopes : [...DEFAULT_OIDC_SCOPES];
  const url = new URL(args.discovery.authorizationEndpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", args.config.clientId);
  url.searchParams.set("redirect_uri", args.redirectUri);
  url.searchParams.set("scope", scopes.join(" "));
  url.searchParams.set("state", args.state);
  url.searchParams.set("nonce", args.nonce);
  url.searchParams.set("code_challenge", args.challenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
}

export async function exchangeCode(args: {
  discovery: OidcDiscovery;
  config: SsoOidcConfig;
  clientSecret: string;
  code: string;
  redirectUri: string;
  verifier: string;
}): Promise<{ idToken: string }> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: args.code,
    redirect_uri: args.redirectUri,
    client_id: args.config.clientId,
    client_secret: args.clientSecret,
    code_verifier: args.verifier,
  });
  const json = (await fetchJson(args.discovery.tokenEndpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: body.toString(),
  })) as Record<string, unknown>;
  const idToken = str(json, "id_token");
  if (!idToken) {
    throw new OidcError(
      "token response had no id_token",
      "The identity provider returned no id_token. Check that the 'openid' scope is allowed for this client.",
    );
  }
  return { idToken };
}

/** JWK → KeyObject, for the two algorithm families IdPs actually use. */
function jwkToKey(key: JwksKey): ReturnType<typeof createPublicKey> {
  if (key.kty !== "RSA" && key.kty !== "EC") {
    throw new OidcError(`unsupported key type ${key.kty}`, "The identity provider uses an unsupported key type.");
  }
  return createPublicKey({ key: key as never, format: "jwk" });
}

const ALGS: Record<string, { node: string; dsa?: "ieee-p1363" }> = {
  RS256: { node: "RSA-SHA256" },
  RS384: { node: "RSA-SHA384" },
  RS512: { node: "RSA-SHA512" },
  ES256: { node: "sha256", dsa: "ieee-p1363" },
  ES384: { node: "sha384", dsa: "ieee-p1363" },
};

export interface IdTokenClaims {
  sub: string;
  email: string | null;
  name: string | null;
  raw: Record<string, unknown>;
}

/**
 * Verifies the id_token end to end and returns the claims we care about.
 * `jwks` is passed in (not fetched here) so this stays a pure function and the
 * tests can pin it down without a network.
 */
export function verifyIdToken(args: {
  idToken: string;
  jwks: { keys: JwksKey[] };
  expectedIssuer: string;
  clientId: string;
  expectedNonce: string;
  emailClaim?: string;
  now?: number;
}): IdTokenClaims {
  const nowSec = Math.floor((args.now ?? Date.now()) / 1000);
  const parts = args.idToken.split(".");
  if (parts.length !== 3) throw new OidcError("id_token is not a JWS", "The identity provider returned a malformed token.");
  const [headerB64, payloadB64, signatureB64] = parts as [string, string, string];

  let header: Record<string, unknown>;
  let payload: Record<string, unknown>;
  try {
    header = JSON.parse(Buffer.from(headerB64, "base64url").toString("utf8")) as Record<string, unknown>;
    payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8")) as Record<string, unknown>;
  } catch {
    throw new OidcError("id_token is not decodable", "The identity provider returned a malformed token.");
  }

  const alg = str(header, "alg");
  /**
   * `alg: none` and HMAC algorithms are refused before any key lookup. Accepting
   * `none` is the textbook JWT vulnerability; accepting HS256 here would let the
   * (public) client_id or a guessable value act as a signing key.
   */
  if (!alg || !ALGS[alg]) {
    throw new OidcError(`unsupported alg ${alg}`, "The identity provider signed the token with an unsupported algorithm.");
  }
  const spec = ALGS[alg] as { node: string; dsa?: "ieee-p1363" };

  const kid = str(header, "kid");
  const candidates = args.jwks.keys.filter((k) => (kid ? k.kid === kid : true)).filter((k) => !k.use || k.use === "sig");
  if (candidates.length === 0) {
    throw new OidcError("no matching JWKS key", "The identity provider's signing key was not found. It may have just rotated; try again.");
  }
  const signature = Buffer.from(signatureB64, "base64url");
  const signed = Buffer.from(`${headerB64}.${payloadB64}`, "utf8");
  const verified = candidates.some((key) => {
    try {
      const verifier = createVerify(spec.node);
      verifier.update(signed);
      return verifier.verify({ key: jwkToKey(key), ...(spec.dsa ? { dsaEncoding: spec.dsa } : {}) }, signature);
    } catch {
      return false;
    }
  });
  if (!verified) throw new OidcError("id_token signature is invalid", "The identity provider's token failed signature validation.");

  if (str(payload, "iss") !== args.expectedIssuer) {
    throw new OidcError("id_token iss mismatch", "The token was issued by a different provider than configured.");
  }

  // `aud` is a string or an array of strings; our client_id must be in it.
  const aud = payload["aud"];
  const audOk = typeof aud === "string" ? aud === args.clientId : Array.isArray(aud) && aud.includes(args.clientId);
  if (!audOk) throw new OidcError("id_token aud mismatch", "The token was issued for a different application.");

  /**
   * `azp` matters when the token has multiple audiences: it names which client
   * the token was actually minted for, and it must be us.
   */
  const azp = str(payload, "azp");
  if (Array.isArray(aud) && aud.length > 1 && azp !== args.clientId) {
    throw new OidcError("id_token azp mismatch", "The token was issued for a different application.");
  }

  if (str(payload, "nonce") !== args.expectedNonce) {
    throw new OidcError("id_token nonce mismatch", "This sign-in could not be verified. Please start again.");
  }

  const exp = typeof payload["exp"] === "number" ? payload["exp"] : null;
  if (exp === null || exp + CLOCK_SKEW_SECONDS < nowSec) {
    throw new OidcError("id_token expired", "The sign-in took too long. Please try again.");
  }
  const iat = typeof payload["iat"] === "number" ? payload["iat"] : null;
  if (iat !== null && iat - CLOCK_SKEW_SECONDS > nowSec) {
    throw new OidcError("id_token issued in the future", "The identity provider's clock is out of sync with this server.");
  }

  const sub = str(payload, "sub");
  if (!sub) throw new OidcError("id_token has no sub", "The identity provider returned a token without a subject.");

  const claim = args.emailClaim ?? DEFAULT_OIDC_EMAIL_CLAIM;
  return {
    sub,
    email: str(payload, claim),
    name: str(payload, "name") ?? str(payload, "given_name"),
    raw: payload,
  };
}

export async function fetchJwks(jwksUri: string): Promise<{ keys: JwksKey[] }> {
  const doc = (await fetchJson(jwksUri)) as { keys?: unknown };
  if (!Array.isArray(doc.keys)) throw new OidcError("JWKS has no keys", "The identity provider's key set is malformed.");
  return { keys: doc.keys as JwksKey[] };
}
