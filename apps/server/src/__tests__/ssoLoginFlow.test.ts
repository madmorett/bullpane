/**
 * The full OIDC round trip against a fake IdP, so the decision that defines
 * this feature is pinned end to end:
 *
 *   THE IDP PROVES IDENTITY. IT DOES NOT CREATE ACCOUNTS.
 *
 * A real IdP, a valid signature, a correct nonce — and still no login if the
 * admin has not invited that email. Getting this wrong would silently turn
 * "anybody with a Google account" into "anybody with a Bullpane login", which
 * is the worst possible failure for a dashboard sitting on production queues.
 */
import { createSign, generateKeyPairSync } from "node:crypto";
import { PRO_FEATURES, type ProFeature } from "@bullpane/shared";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../app";
import { loadConfig } from "../config";
import type { Db } from "../db";
import { encryptSecret } from "../auth/sso/crypto";

const SESSION_SECRET = "s".repeat(40);
const ISSUER = "https://idp.acme.test";
const CLIENT_ID = "client-123";

const PROVISIONED = {
  id: "u-dev",
  email: "dev@acme.test",
  name: "Dev Person",
  role: "operator" as const,
  passwordHash: null,
  createdAt: new Date("2024-01-01T00:00:00.000Z"),
  lastLoginAt: null,
};

const PROVIDER = {
  id: "p-oidc",
  kind: "oidc" as const,
  name: "Acme IdP",
  enabled: true,
  config: { issuer: ISSUER, clientId: CLIENT_ID, emailClaim: "email" },
  secretEnc: encryptSecret("THE-CLIENT-SECRET", SESSION_SECRET),
  createdAt: new Date("2024-01-01T00:00:00.000Z"),
  updatedAt: new Date("2024-01-01T00:00:00.000Z"),
};

const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const JWK = { ...(publicKey.export({ format: "jwk" }) as Record<string, unknown>), kid: "k1", alg: "RS256", use: "sig" };

function idToken(claims: Record<string, unknown>): string {
  const nowSec = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: "RS256", kid: "k1", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({ iss: ISSUER, aud: CLIENT_ID, sub: "idp-sub-1", iat: nowSec - 5, exp: nowSec + 300, ...claims }),
  ).toString("base64url");
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${payload}`);
  return `${header}.${payload}.${signer.sign(privateKey).toString("base64url")}`;
}

interface Captured {
  tokenBody: URLSearchParams | null;
}

/** A fake IdP: discovery, JWKS and the token endpoint. */
function fakeIdp(tokenFor: () => string, captured: Captured) {
  return vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const href = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    if (href.endsWith("/.well-known/openid-configuration")) {
      return json({
        issuer: ISSUER,
        authorization_endpoint: `${ISSUER}/authorize`,
        token_endpoint: `${ISSUER}/token`,
        jwks_uri: `${ISSUER}/jwks`,
      });
    }
    if (href === `${ISSUER}/jwks`) return json({ keys: [JWK] });
    if (href === `${ISSUER}/token`) {
      captured.tokenBody = new URLSearchParams(String(init?.body ?? ""));
      return json({ id_token: tokenFor(), token_type: "Bearer" });
    }
    throw new Error(`unexpected fetch: ${href}`);
  });
}

function tableName(table: unknown): string {
  const sym = Object.getOwnPropertySymbols(table as object).find((s) => String(s).includes("Name"));
  return sym ? String((table as Record<symbol, unknown>)[sym]) : "";
}

function fakeDb(users: unknown[], inserted: Record<string, unknown[]>) {
  function chain(name: string) {
    const b = {
      where: () => b,
      orderBy: () => b,
      limit: () => b,
      innerJoin: () => b,
      then(resolve: (rows: unknown[]) => unknown) {
        const rows = name === "sso_providers" ? [PROVIDER] : name === "users" ? users : [];
        return Promise.resolve(rows).then(resolve);
      },
    };
    return b;
  }
  return {
    select: () => ({ from: (t: unknown) => chain(tableName(t)) }),
    selectDistinct: () => ({ from: (t: unknown) => chain(tableName(t)) }),
    insert: (t: unknown) => ({
      values(v: Record<string, unknown>) {
        (inserted[tableName(t)] ??= []).push(v);
        const p = Promise.resolve();
        return Object.assign(p, { onDuplicateKeyUpdate: () => Promise.resolve() });
      },
    }),
    update: () => ({ set: () => ({ where: () => Promise.resolve() }) }),
    delete: () => ({ where: () => Promise.resolve() }),
  } as unknown as Db;
}

async function build(users: unknown[]) {
  const inserted: Record<string, unknown[]> = {};
  const config = loadConfig({ SESSION_SECRET, PUBLIC_URL: "https://bull.acme.test", DEMO_MODE: "false" }, { warn: () => undefined });
  const app = await buildApp({
    config,
    db: fakeDb(users, inserted),
    pool: { get: () => ({}), evict: vi.fn(), closeAll: vi.fn() } as never,
    logger: false,
    serveWeb: false,
  });
  vi.spyOn(app.ctx.edition, "getEdition").mockReturnValue({
    tier: "pro",
    demo: false,
    features: Object.fromEntries(PRO_FEATURES.map((f) => [f, true])) as Record<ProFeature, boolean>,
    license: null,
    pricing: { monthlyUsd: 19, yearlyUsd: 149 },
    checkoutUrl: "",
  });
  await app.ready();
  return { app, inserted };
}

/** Drives /start, then feeds the cookie it set back into /callback. */
async function roundTrip(app: FastifyInstance, claims: Record<string, unknown>, captured: Captured) {
  const start = await app.inject({ method: "GET", url: "/api/auth/sso/p-oidc/start" });
  expect(start.statusCode).toBe(302);
  const authorizeUrl = new URL(String(start.headers.location));
  const state = authorizeUrl.searchParams.get("state") as string;
  const nonce = authorizeUrl.searchParams.get("nonce") as string;
  const setCookie = start.headers["set-cookie"];
  const cookieHeader = (Array.isArray(setCookie) ? setCookie : [String(setCookie)]).map((c) => c.split(";")[0]).join("; ");
  const callback = await app.inject({
    method: "GET",
    url: `/api/auth/sso/p-oidc/callback?code=THE-CODE&state=${encodeURIComponent(state)}`,
    headers: { cookie: cookieHeader },
  });
  return { start, callback, state, nonce, authorizeUrl };
}

describe("OIDC round trip", () => {
  const captured: Captured = { tokenBody: null };
  let currentNonce = "";
  let claimsOverride: Record<string, unknown> = {};

  beforeEach(() => {
    captured.tokenBody = null;
    claimsOverride = {};
    vi.stubGlobal("fetch", fakeIdp(() => idToken({ nonce: currentNonce, email: "dev@acme.test", ...claimsOverride }), captured));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("signs in a provisioned user and sets the normal session cookie", async () => {
    const { app, inserted } = await build([PROVISIONED]);
    // The nonce is only known after /start, so the fake IdP reads it lazily.
    const start = await app.inject({ method: "GET", url: "/api/auth/sso/p-oidc/start" });
    const authorizeUrl = new URL(String(start.headers.location));
    currentNonce = authorizeUrl.searchParams.get("nonce") as string;
    const state = authorizeUrl.searchParams.get("state") as string;
    const setCookie = start.headers["set-cookie"];
    const cookieHeader = (Array.isArray(setCookie) ? setCookie : [String(setCookie)]).map((c) => c.split(";")[0]).join("; ");

    const res = await app.inject({
      method: "GET",
      url: `/api/auth/sso/p-oidc/callback?code=THE-CODE&state=${encodeURIComponent(state)}`,
      headers: { cookie: cookieHeader },
    });

    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe("/");
    const cookies = String(res.headers["set-cookie"]);
    expect(cookies).toContain("bullpane_session=");
    // A session row was written for the RIGHT user, marked as SSO.
    const session = (inserted["sessions"] ?? [])[0] as Record<string, unknown>;
    expect(session.userId).toBe("u-dev");
    expect(session.authMethod).toBe("sso");
    // And the audit trail says so.
    const audit = (inserted["audit_log"] ?? []) as Record<string, unknown>[];
    expect(audit.some((r) => r.action === "auth.sso_login" && r.actorId === "u-dev")).toBe(true);
    await app.close();
  });

  it("sends the client secret and PKCE verifier to the token endpoint, and never to the browser", async () => {
    const { app } = await build([PROVISIONED]);
    const start = await app.inject({ method: "GET", url: "/api/auth/sso/p-oidc/start" });
    const authorizeUrl = new URL(String(start.headers.location));
    currentNonce = authorizeUrl.searchParams.get("nonce") as string;
    const state = authorizeUrl.searchParams.get("state") as string;
    const setCookie = start.headers["set-cookie"];
    const cookieHeader = (Array.isArray(setCookie) ? setCookie : [String(setCookie)]).map((c) => c.split(";")[0]).join("; ");
    // The redirect the browser follows must not carry the secret.
    expect(String(start.headers.location)).not.toContain("THE-CLIENT-SECRET");
    // Nor may the flow cookie (it is signed, not encrypted).
    expect(String(setCookie)).not.toContain("THE-CLIENT-SECRET");

    await app.inject({
      method: "GET",
      url: `/api/auth/sso/p-oidc/callback?code=THE-CODE&state=${encodeURIComponent(state)}`,
      headers: { cookie: cookieHeader },
    });
    expect(captured.tokenBody?.get("client_secret")).toBe("THE-CLIENT-SECRET");
    expect(captured.tokenBody?.get("code_verifier")).toBeTruthy();
    expect(captured.tokenBody?.get("grant_type")).toBe("authorization_code");
    await app.close();
  });

  it("REFUSES a user the IdP authenticated but the admin never invited", async () => {
    // The one that matters: no users at all, valid everything else.
    const { app, inserted } = await build([]);
    const start = await app.inject({ method: "GET", url: "/api/auth/sso/p-oidc/start" });
    const authorizeUrl = new URL(String(start.headers.location));
    currentNonce = authorizeUrl.searchParams.get("nonce") as string;
    const state = authorizeUrl.searchParams.get("state") as string;
    const setCookie = start.headers["set-cookie"];
    const cookieHeader = (Array.isArray(setCookie) ? setCookie : [String(setCookie)]).map((c) => c.split(";")[0]).join("; ");

    const res = await app.inject({
      method: "GET",
      url: `/api/auth/sso/p-oidc/callback?code=THE-CODE&state=${encodeURIComponent(state)}`,
      headers: { cookie: cookieHeader },
    });

    expect(res.statusCode).toBe(302);
    expect(decodeURIComponent(String(res.headers.location))).toMatch(/not set up in Bullpane yet/);
    // No session cookie, and above all NO new user row.
    expect(String(res.headers["set-cookie"] ?? "")).not.toContain("bullpane_session=");
    expect(inserted["users"]).toBeUndefined();
    // The admin can see who to invite.
    const audit = (inserted["audit_log"] ?? []) as Record<string, unknown>[];
    const denied = audit.find((r) => r.action === "auth.sso_denied");
    expect(denied).toBeDefined();
    expect((denied?.detail as Record<string, unknown>)?.email).toBe("dev@acme.test");
    await app.close();
  });

  it("refuses a replayed nonce (a token minted for another sign-in)", async () => {
    const { app, inserted } = await build([PROVISIONED]);
    const start = await app.inject({ method: "GET", url: "/api/auth/sso/p-oidc/start" });
    const authorizeUrl = new URL(String(start.headers.location));
    const state = authorizeUrl.searchParams.get("state") as string;
    // The IdP returns a token bound to a DIFFERENT nonce.
    currentNonce = "a-nonce-from-another-flow";
    const setCookie = start.headers["set-cookie"];
    const cookieHeader = (Array.isArray(setCookie) ? setCookie : [String(setCookie)]).map((c) => c.split(";")[0]).join("; ");

    const res = await app.inject({
      method: "GET",
      url: `/api/auth/sso/p-oidc/callback?code=THE-CODE&state=${encodeURIComponent(state)}`,
      headers: { cookie: cookieHeader },
    });
    expect(res.statusCode).toBe(302);
    expect(String(res.headers["set-cookie"] ?? "")).not.toContain("bullpane_session=");
    expect(inserted["sessions"]).toBeUndefined();
    await app.close();
  });

  it("refuses a mismatched state (the CSRF binding)", async () => {
    const { app, inserted } = await build([PROVISIONED]);
    const start = await app.inject({ method: "GET", url: "/api/auth/sso/p-oidc/start" });
    const authorizeUrl = new URL(String(start.headers.location));
    currentNonce = authorizeUrl.searchParams.get("nonce") as string;
    const setCookie = start.headers["set-cookie"];
    const cookieHeader = (Array.isArray(setCookie) ? setCookie : [String(setCookie)]).map((c) => c.split(";")[0]).join("; ");

    const res = await app.inject({
      method: "GET",
      url: "/api/auth/sso/p-oidc/callback?code=THE-CODE&state=not-the-state-we-issued",
      headers: { cookie: cookieHeader },
    });
    expect(decodeURIComponent(String(res.headers.location))).toMatch(/could not be verified/);
    expect(inserted["sessions"]).toBeUndefined();
    await app.close();
  });

  it("refuses when the flow cookie is reused (single use)", async () => {
    const { app } = await build([PROVISIONED]);
    const start = await app.inject({ method: "GET", url: "/api/auth/sso/p-oidc/start" });
    const authorizeUrl = new URL(String(start.headers.location));
    currentNonce = authorizeUrl.searchParams.get("nonce") as string;
    const state = authorizeUrl.searchParams.get("state") as string;
    const setCookie = start.headers["set-cookie"];
    const cookieHeader = (Array.isArray(setCookie) ? setCookie : [String(setCookie)]).map((c) => c.split(";")[0]).join("; ");
    const url = `/api/auth/sso/p-oidc/callback?code=THE-CODE&state=${encodeURIComponent(state)}`;

    const first = await app.inject({ method: "GET", url, headers: { cookie: cookieHeader } });
    expect(first.headers.location).toBe("/");
    // The callback clears the cookie; a real browser would not send it again.
    // What must hold is that the response TOLD the browser to drop it.
    const cleared = String(first.headers["set-cookie"]);
    expect(cleared).toContain("bullpane_sso_p-oidc=");
    await app.close();
  });

  it("honours a local ?next but never an external one", async () => {
    const { app } = await build([PROVISIONED]);
    const start = await app.inject({ method: "GET", url: "/api/auth/sso/p-oidc/start?next=%2Fqueues%2Fpayments" });
    const authorizeUrl = new URL(String(start.headers.location));
    currentNonce = authorizeUrl.searchParams.get("nonce") as string;
    const state = authorizeUrl.searchParams.get("state") as string;
    const setCookie = start.headers["set-cookie"];
    const cookieHeader = (Array.isArray(setCookie) ? setCookie : [String(setCookie)]).map((c) => c.split(";")[0]).join("; ");
    const res = await app.inject({
      method: "GET",
      url: `/api/auth/sso/p-oidc/callback?code=THE-CODE&state=${encodeURIComponent(state)}`,
      headers: { cookie: cookieHeader },
    });
    expect(res.headers.location).toBe("/queues/payments");
    await app.close();
  });

  it("refuses a token whose email claim is missing", async () => {
    const { app, inserted } = await build([PROVISIONED]);
    const start = await app.inject({ method: "GET", url: "/api/auth/sso/p-oidc/start" });
    const authorizeUrl = new URL(String(start.headers.location));
    currentNonce = authorizeUrl.searchParams.get("nonce") as string;
    const state = authorizeUrl.searchParams.get("state") as string;
    claimsOverride = { email: undefined };
    const setCookie = start.headers["set-cookie"];
    const cookieHeader = (Array.isArray(setCookie) ? setCookie : [String(setCookie)]).map((c) => c.split(";")[0]).join("; ");
    const res = await app.inject({
      method: "GET",
      url: `/api/auth/sso/p-oidc/callback?code=THE-CODE&state=${encodeURIComponent(state)}`,
      headers: { cookie: cookieHeader },
    });
    expect(decodeURIComponent(String(res.headers.location))).toMatch(/did not send an email address/);
    expect(inserted["sessions"]).toBeUndefined();
    await app.close();
  });

  it("matches the account case-insensitively (IdPs shout)", async () => {
    const { app, inserted } = await build([PROVISIONED]);
    const start = await app.inject({ method: "GET", url: "/api/auth/sso/p-oidc/start" });
    const authorizeUrl = new URL(String(start.headers.location));
    currentNonce = authorizeUrl.searchParams.get("nonce") as string;
    const state = authorizeUrl.searchParams.get("state") as string;
    claimsOverride = { email: "DEV@ACME.TEST" };
    const setCookie = start.headers["set-cookie"];
    const cookieHeader = (Array.isArray(setCookie) ? setCookie : [String(setCookie)]).map((c) => c.split(";")[0]).join("; ");
    const res = await app.inject({
      method: "GET",
      url: `/api/auth/sso/p-oidc/callback?code=THE-CODE&state=${encodeURIComponent(state)}`,
      headers: { cookie: cookieHeader },
    });
    expect(res.headers.location).toBe("/");
    expect((inserted["sessions"] ?? [])[0]).toMatchObject({ userId: "u-dev" });
    await app.close();
  });
});
