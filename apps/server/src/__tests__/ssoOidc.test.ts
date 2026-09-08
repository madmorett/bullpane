/**
 * These tests exist because every check in verifyIdToken is a door. A regression
 * here does not break a feature, it lets somebody in.
 */
import { createSign, generateKeyPairSync, type KeyObject } from "node:crypto";
import { describe, expect, it } from "vitest";
import { authorizationUrl, createPkce, discoveryUrl, OidcError, verifyIdToken } from "../auth/sso/oidc";

const ISSUER = "https://idp.example.com";
const CLIENT_ID = "bullpane-client";
const NONCE = "nonce-value";
const NOW = Date.UTC(2026, 5, 1, 12, 0, 0);

function rsaKeypair(kid: string) {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = publicKey.export({ format: "jwk" }) as Record<string, unknown>;
  return { privateKey, jwk: { ...jwk, kid, alg: "RS256", use: "sig" } };
}

function signJwt(payload: Record<string, unknown>, privateKey: KeyObject, header: Record<string, unknown>): string {
  const h = Buffer.from(JSON.stringify(header)).toString("base64url");
  const p = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signer = createSign("RSA-SHA256");
  signer.update(`${h}.${p}`);
  return `${h}.${p}.${signer.sign(privateKey).toString("base64url")}`;
}

function validPayload(over: Record<string, unknown> = {}) {
  const nowSec = Math.floor(NOW / 1000);
  return {
    iss: ISSUER,
    aud: CLIENT_ID,
    sub: "idp-user-1",
    nonce: NONCE,
    email: "dev@acme.test",
    name: "Dev Person",
    iat: nowSec - 10,
    exp: nowSec + 300,
    ...over,
  };
}

/**
 * Refusals are asserted on `publicMessage` — what the person signing in
 * actually sees — not on the internal `message`, which is a log detail.
 */
function expectRefusal(fn: () => unknown, publicPattern: RegExp) {
  let thrown: unknown;
  try {
    fn();
  } catch (err) {
    thrown = err;
  }
  expect(thrown).toBeInstanceOf(OidcError);
  expect((thrown as OidcError).publicMessage).toMatch(publicPattern);
}

function setup(kid = "key-1") {
  const { privateKey, jwk } = rsaKeypair(kid);
  const jwks = { keys: [jwk] } as never;
  const verify = (token: string, over: Record<string, unknown> = {}) =>
    verifyIdToken({
      idToken: token,
      jwks,
      expectedIssuer: ISSUER,
      clientId: CLIENT_ID,
      expectedNonce: NONCE,
      now: NOW,
      ...over,
    });
  const sign = (payload: Record<string, unknown>, header: Record<string, unknown> = { alg: "RS256", kid, typ: "JWT" }) =>
    signJwt(payload, privateKey, header);
  return { sign, verify, privateKey, jwk };
}

describe("verifyIdToken — happy path", () => {
  it("accepts a correctly signed token and returns the claims", () => {
    const { sign, verify } = setup();
    const claims = verify(sign(validPayload()));
    expect(claims.sub).toBe("idp-user-1");
    expect(claims.email).toBe("dev@acme.test");
    expect(claims.name).toBe("Dev Person");
  });

  it("accepts an array aud that contains our client_id", () => {
    const { sign, verify } = setup();
    expect(verify(sign(validPayload({ aud: [CLIENT_ID], azp: CLIENT_ID }))).sub).toBe("idp-user-1");
  });

  it("reads the email from a custom claim when configured", () => {
    const { sign, verify } = setup();
    const token = sign(validPayload({ email: undefined, upn: "dev@acme.test" }));
    expect(verify(token, { emailClaim: "upn" }).email).toBe("dev@acme.test");
  });

  it("matches a key by kid among several, and ignores encryption keys", () => {
    const { privateKey, jwk } = rsaKeypair("key-1");
    const other = rsaKeypair("key-2");
    const token = signJwt(validPayload(), privateKey, { alg: "RS256", kid: "key-1", typ: "JWT" });
    const claims = verifyIdToken({
      idToken: token,
      jwks: { keys: [{ ...other.jwk, use: "enc" }, jwk] } as never,
      expectedIssuer: ISSUER,
      clientId: CLIENT_ID,
      expectedNonce: NONCE,
      now: NOW,
    });
    expect(claims.sub).toBe("idp-user-1");
  });
});

describe("verifyIdToken — the doors that must stay shut", () => {
  it('refuses alg "none" (the textbook JWT hole)', () => {
    const { verify } = setup();
    const h = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
    const p = Buffer.from(JSON.stringify(validPayload())).toString("base64url");
    expect(() => verify(`${h}.${p}.`)).toThrow(OidcError);
  });

  it("refuses an HMAC-signed token (alg confusion)", () => {
    const { verify } = setup();
    const h = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
    const p = Buffer.from(JSON.stringify(validPayload())).toString("base64url");
    expect(() => verify(`${h}.${p}.anything`)).toThrow(/unsupported alg/);
  });

  it("refuses a token signed by a key that is not in the JWKS", () => {
    const { verify } = setup("key-1");
    const attacker = rsaKeypair("key-1");
    const forged = signJwt(validPayload(), attacker.privateKey, { alg: "RS256", kid: "key-1", typ: "JWT" });
    expectRefusal(() => verify(forged), /failed signature validation/);
  });

  it("refuses a tampered payload", () => {
    const { sign, verify } = setup();
    const token = sign(validPayload());
    const [h, , s] = token.split(".");
    const evil = Buffer.from(JSON.stringify(validPayload({ email: "admin@acme.test" }))).toString("base64url");
    expectRefusal(() => verify(`${h}.${evil}.${s}`), /failed signature validation/);
  });

  it("refuses a token from a different issuer", () => {
    const { sign, verify } = setup();
    expectRefusal(() => verify(sign(validPayload({ iss: "https://evil.example.com" }))), /different provider/);
  });

  it("refuses a token minted for a different application (confused deputy)", () => {
    const { sign, verify } = setup();
    expectRefusal(() => verify(sign(validPayload({ aud: "some-other-app" }))), /different application/);
  });

  it("refuses a multi-audience token whose azp is not us", () => {
    const { sign, verify } = setup();
    const token = sign(validPayload({ aud: [CLIENT_ID, "other-app"], azp: "other-app" }));
    expectRefusal(() => verify(token), /different application/);
  });

  it("refuses a replayed token (nonce mismatch)", () => {
    const { sign, verify } = setup();
    expectRefusal(() => verify(sign(validPayload({ nonce: "someone-elses-nonce" }))), /could not be verified/);
  });

  it("refuses a token with no nonce at all", () => {
    const { sign, verify } = setup();
    expectRefusal(() => verify(sign(validPayload({ nonce: undefined }))), /could not be verified/);
  });

  it("refuses an expired token, allowing only the stated skew", () => {
    const { sign, verify } = setup();
    const nowSec = Math.floor(NOW / 1000);
    expectRefusal(() => verify(sign(validPayload({ exp: nowSec - 300 }))), /took too long/);
    // Inside the 120 s skew window it still passes.
    expect(verify(sign(validPayload({ exp: nowSec - 60 }))).sub).toBe("idp-user-1");
  });

  it("refuses a token with no exp", () => {
    const { sign, verify } = setup();
    expectRefusal(() => verify(sign(validPayload({ exp: undefined }))), /took too long/);
  });

  it("refuses a token issued in the future (IdP clock way off)", () => {
    const { sign, verify } = setup();
    const nowSec = Math.floor(NOW / 1000);
    expectRefusal(() => verify(sign(validPayload({ iat: nowSec + 3600 }))), /clock is out of sync/);
  });

  it("refuses a token with no sub", () => {
    const { sign, verify } = setup();
    expectRefusal(() => verify(sign(validPayload({ sub: undefined }))), /without a subject/);
  });

  it("refuses malformed input instead of crashing", () => {
    const { verify } = setup();
    for (const bad of ["", "a", "a.b", "a.b.c.d", "not.a.jwt"]) {
      expect(() => verify(bad)).toThrow(OidcError);
    }
  });

  it("reports a missing key as retryable rather than as forgery", () => {
    const { sign, verify } = setup("key-1");
    const token = sign(validPayload(), { alg: "RS256", kid: "rotated-key", typ: "JWT" });
    expectRefusal(() => verify(token), /may have just rotated/);
  });
});

describe("PKCE and URLs", () => {
  it("derives an S256 challenge that is not the verifier", () => {
    const { verifier, challenge } = createPkce();
    expect(verifier).not.toBe(challenge);
    expect(verifier.length).toBeGreaterThan(32);
    expect(challenge).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(createPkce().verifier).not.toBe(verifier);
  });

  it("builds an authorization URL with PKCE, state and nonce", () => {
    const url = new URL(
      authorizationUrl({
        discovery: {
          issuer: ISSUER,
          authorizationEndpoint: `${ISSUER}/authorize`,
          tokenEndpoint: `${ISSUER}/token`,
          jwksUri: `${ISSUER}/jwks`,
          userinfoEndpoint: null,
        },
        config: { issuer: ISSUER, clientId: CLIENT_ID },
        redirectUri: "https://bull.acme.test/api/auth/sso/p1/callback",
        state: "state-1",
        nonce: NONCE,
        challenge: "challenge-1",
      }),
    );
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("client_id")).toBe(CLIENT_ID);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("code_challenge")).toBe("challenge-1");
    expect(url.searchParams.get("state")).toBe("state-1");
    expect(url.searchParams.get("nonce")).toBe(NONCE);
    expect(url.searchParams.get("scope")).toBe("openid email profile");
    // The secret must never end up in a URL the browser sees.
    expect(url.toString()).not.toContain("client_secret");
  });

  it("honours custom scopes and normalises the discovery URL", () => {
    const url = new URL(
      authorizationUrl({
        discovery: {
          issuer: ISSUER,
          authorizationEndpoint: `${ISSUER}/authorize`,
          tokenEndpoint: `${ISSUER}/token`,
          jwksUri: `${ISSUER}/jwks`,
          userinfoEndpoint: null,
        },
        config: { issuer: ISSUER, clientId: CLIENT_ID, scopes: ["openid", "email"] },
        redirectUri: "https://bull.acme.test/cb",
        state: "s",
        nonce: "n",
        challenge: "c",
      }),
    );
    expect(url.searchParams.get("scope")).toBe("openid email");
    expect(discoveryUrl("https://idp.example.com/")).toBe("https://idp.example.com/.well-known/openid-configuration");
    expect(discoveryUrl("https://idp.example.com")).toBe("https://idp.example.com/.well-known/openid-configuration");
  });
});
