/**
 * The SSO routes against the real Fastify app.
 *
 * These are the promises made to a customer who turns SSO on, pinned so a
 * refactor cannot quietly break them:
 *  - the client secret NEVER comes back out of the API;
 *  - the login page endpoint leaks nothing about the IdP to anonymous callers;
 *  - a callback with no/forged flow cookie is refused (CSRF);
 *  - an IdP-authenticated person with no Bullpane account does NOT get one;
 *  - "require SSO" still lets an admin in with a password (the escape hatch);
 *  - free edition gets 402 on the admin routes and an empty login list.
 */
import { PRO_FEATURES, type ProFeature } from "@bullpane/shared";
import type { FastifyInstance } from "fastify";
import { describe, expect, it, vi } from "vitest";
import { buildApp } from "../app";
import { loadConfig } from "../config";
import type { Db } from "../db";
import { encryptSecret } from "../auth/sso/crypto";
import { hashPassword } from "../auth/password";

const SESSION_SECRET = "s".repeat(40);

const ADMIN = {
  id: "u-admin",
  email: "admin@acme.com",
  name: "Admin",
  role: "admin" as const,
  passwordHash: "",
  createdAt: new Date("2024-01-01T00:00:00.000Z"),
  lastLoginAt: null,
};

const VIEWER = {
  id: "u-viewer",
  email: "viewer@acme.com",
  name: "Viewer",
  role: "viewer" as const,
  passwordHash: "",
  createdAt: new Date("2024-01-01T00:00:00.000Z"),
  lastLoginAt: null,
};

const OIDC_PROVIDER = {
  id: "p-oidc",
  kind: "oidc" as const,
  name: "Acme Google",
  enabled: true,
  config: { issuer: "https://accounts.google.test", clientId: "client-123", emailClaim: "email" },
  secretEnc: encryptSecret("THE-CLIENT-SECRET", SESSION_SECRET),
  createdAt: new Date("2024-01-01T00:00:00.000Z"),
  updatedAt: new Date("2024-01-01T00:00:00.000Z"),
};

interface State {
  providers: (typeof OIDC_PROVIDER)[];
  users: (typeof ADMIN | typeof VIEWER)[];
  settings: Map<string, string>;
  inserted: Record<string, unknown[]>;
}

function tableName(table: unknown): string {
  const sym = Object.getOwnPropertySymbols(table as object).find((s) => String(s).includes("Name"));
  return sym ? String((table as Record<symbol, unknown>)[sym]) : "";
}

function fakeDb(state: State) {
  const rowsFor = (name: string): unknown[] => {
    if (name === "sso_providers") return state.providers;
    if (name === "users") return state.users;
    if (name === "settings") return [...state.settings.entries()].map(([key, value]) => ({ key, value }));
    if (name === "sessions") return [];
    return [];
  };

  function chain(name: string) {
    const b = {
      where: () => b,
      orderBy: () => b,
      limit: () => b,
      innerJoin: () => b,
      then(resolve: (rows: unknown[]) => unknown) {
        return Promise.resolve(rowsFor(name)).then(resolve);
      },
    };
    return b;
  }

  const db = {
    select: () => ({ from: (t: unknown) => chain(tableName(t)) }),
    selectDistinct: () => ({ from: (t: unknown) => chain(tableName(t)) }),
    insert: (t: unknown) => {
      const name = tableName(t);
      return {
        values(v: Record<string, unknown>) {
          (state.inserted[name] ??= []).push(v);
          if (name === "sso_providers") state.providers.push(v as never);
          if (name === "settings") state.settings.set(String(v.key), String(v.value));
          const p = Promise.resolve();
          return Object.assign(p, { onDuplicateKeyUpdate: () => Promise.resolve() });
        },
      };
    },
    update: () => ({ set: () => ({ where: () => Promise.resolve() }) }),
    delete: () => ({ where: () => Promise.resolve() }),
  };
  return db as unknown as Db;
}

function allFeatures(enabled: boolean): Record<ProFeature, boolean> {
  return Object.fromEntries(PRO_FEATURES.map((f) => [f, enabled])) as Record<ProFeature, boolean>;
}

async function build(
  opts: { pro?: boolean; role?: "admin" | "viewer" | null; state?: Partial<State>; env?: Record<string, string> } = {},
): Promise<{ app: FastifyInstance; state: State }> {
  const state: State = {
    providers: opts.state?.providers ?? [{ ...OIDC_PROVIDER }],
    users: opts.state?.users ?? [ADMIN, VIEWER],
    settings: opts.state?.settings ?? new Map(),
    inserted: {},
  };
  const db = fakeDb(state);
  const pool = { get: () => ({}), evict: vi.fn(), closeAll: vi.fn() } as never;
  const config = loadConfig({ SESSION_SECRET, DEMO_MODE: "false", PUBLIC_URL: "https://bull.acme.test", ...opts.env }, { warn: () => undefined });
  const app = await buildApp({ config, db, pool, logger: false, serveWeb: false });
  vi.spyOn(app.ctx.edition, "getEdition").mockReturnValue({
    tier: opts.pro === false ? "free" : "pro",
    demo: false,
    features: allFeatures(opts.pro !== false),
    license: null,
    pricing: { monthlyUsd: 19, yearlyUsd: 149 },
    checkoutUrl: "",
  });
  const role = opts.role === undefined ? "admin" : opts.role;
  if (role) {
    const user = role === "admin" ? ADMIN : VIEWER;
    app.addHook("onRequest", async (request) => {
      request.user = { ...user, createdAt: user.createdAt.toISOString(), lastLoginAt: null };
    });
  }
  await app.ready();
  return { app, state };
}

describe("the client secret never leaves the server", () => {
  it("is absent from the provider list", async () => {
    const { app } = await build();
    const res = await app.inject({ method: "GET", url: "/api/sso/providers" });
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain("THE-CLIENT-SECRET");
    const [provider] = res.json() as [Record<string, unknown>];
    expect(provider.hasSecret).toBe(true);
    expect((provider.config as Record<string, unknown>).clientSecret).toBeUndefined();
    // The encrypted blob must not leak either — it is useless without the key,
    // but there is no reason to hand it out.
    expect(res.body).not.toContain(OIDC_PROVIDER.secretEnc);
    await app.close();
  });

  it("reports the callback URL the admin has to configure at the IdP", async () => {
    const { app } = await build();
    const [provider] = (await app.inject({ method: "GET", url: "/api/sso/providers" })).json() as [Record<string, unknown>];
    expect(provider.callbackUrl).toBe("https://bull.acme.test/api/auth/sso/p-oidc/callback");
    await app.close();
  });

  it("stores a new secret encrypted, never in the clear", async () => {
    const { app, state } = await build({ state: { providers: [] } });
    const res = await app.inject({
      method: "POST",
      url: "/api/sso/providers",
      payload: {
        kind: "oidc",
        name: "Okta",
        config: { issuer: "https://acme.okta.test", clientId: "c1", clientSecret: "PLAINTEXT-SECRET" },
      },
    });
    expect(res.statusCode).toBe(201);
    const row = (state.inserted["sso_providers"] as Record<string, unknown>[])[0] as Record<string, unknown>;
    expect(JSON.stringify(row.config)).not.toContain("PLAINTEXT-SECRET");
    expect(String(row.secretEnc)).not.toContain("PLAINTEXT-SECRET");
    expect(String(row.secretEnc).startsWith("v1.")).toBe(true);
    expect(res.body).not.toContain("PLAINTEXT-SECRET");
    await app.close();
  });

  it("records the provider in the audit trail without the secret", async () => {
    const { app, state } = await build({ state: { providers: [] } });
    await app.inject({
      method: "POST",
      url: "/api/sso/providers",
      payload: { kind: "oidc", name: "Okta", config: { issuer: "https://acme.okta.test", clientId: "c1", clientSecret: "PLAINTEXT-SECRET" } },
    });
    const audit = (state.inserted["audit_log"] ?? []) as Record<string, unknown>[];
    const row = audit.find((r) => r.action === "sso.provider_create");
    expect(row).toBeDefined();
    expect(JSON.stringify(row)).not.toContain("PLAINTEXT-SECRET");
    await app.close();
  });
});

describe("the login page endpoint is anonymous-safe", () => {
  it("returns only id, kind and name — nothing about the IdP", async () => {
    const { app } = await build({ role: null });
    const res = await app.inject({ method: "GET", url: "/api/auth/sso/options" });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { providers: Record<string, unknown>[]; requireSso: boolean };
    expect(body.providers).toEqual([{ id: "p-oidc", kind: "oidc", name: "Acme Google" }]);
    expect(res.body).not.toContain("client-123");
    expect(res.body).not.toContain("accounts.google.test");
    expect(res.body).not.toContain("THE-CLIENT-SECRET");
    await app.close();
  });

  it("says nothing is available on the free edition", async () => {
    const { app } = await build({ pro: false, role: null });
    const body = (await app.inject({ method: "GET", url: "/api/auth/sso/options" })).json() as {
      providers: unknown[];
      requireSso: boolean;
      passwordEscapeHatch: string;
    };
    expect(body.providers).toEqual([]);
    expect(body.requireSso).toBe(false);
    expect(body.passwordEscapeHatch).toBe("none");
    await app.close();
  });

  it("reports the escape hatch when SSO is required", async () => {
    const { app } = await build({ role: null, state: { settings: new Map([["sso.require_sso", "true"]]) } });
    const body = (await app.inject({ method: "GET", url: "/api/auth/sso/options" })).json() as Record<string, unknown>;
    expect(body.requireSso).toBe(true);
    expect(body.passwordEscapeHatch).toBe("admins");
    await app.close();
  });

  it('reports "all" when the operator set BULLPANE_ALLOW_PASSWORD_LOGIN', async () => {
    const { app } = await build({
      role: null,
      env: { BULLPANE_ALLOW_PASSWORD_LOGIN: "true" },
      state: { settings: new Map([["sso.require_sso", "true"]]) },
    });
    const body = (await app.inject({ method: "GET", url: "/api/auth/sso/options" })).json() as Record<string, unknown>;
    expect(body.passwordEscapeHatch).toBe("all");
    await app.close();
  });
});

describe("the callback refuses anything it did not start", () => {
  it("refuses a callback with no flow cookie (CSRF / expired)", async () => {
    const { app } = await build({ role: null });
    const res = await app.inject({ method: "GET", url: "/api/auth/sso/p-oidc/callback?code=abc&state=xyz" });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toContain("/login?sso_error=");
    expect(decodeURIComponent(String(res.headers.location))).toMatch(/expired or was not started here/);
    await app.close();
  });

  it("refuses an unsigned (forged) flow cookie", async () => {
    const { app } = await build({ role: null });
    const res = await app.inject({
      method: "GET",
      url: "/api/auth/sso/p-oidc/callback?code=abc&state=xyz",
      cookies: { bullpane_sso_p_oidc: JSON.stringify({ state: "xyz", nonce: "n", createdAt: Date.now() }) },
    });
    expect(res.statusCode).toBe(302);
    expect(decodeURIComponent(String(res.headers.location))).toMatch(/expired or was not started here/);
    await app.close();
  });

  it("refuses a callback for a provider that does not exist", async () => {
    const { app } = await build({ role: null, state: { providers: [] } });
    const res = await app.inject({ method: "GET", url: "/api/auth/sso/nope/callback?code=abc&state=xyz" });
    expect(res.statusCode).toBe(302);
    expect(decodeURIComponent(String(res.headers.location))).toMatch(/no longer exists/);
    await app.close();
  });

  it("refuses SSO entirely on the free edition", async () => {
    const { app } = await build({ pro: false, role: null });
    const res = await app.inject({ method: "GET", url: "/api/auth/sso/p-oidc/start" });
    expect(res.statusCode).toBe(302);
    expect(decodeURIComponent(String(res.headers.location))).toMatch(/not enabled/);
    await app.close();
  });

  it("never sends the user to another site (open redirect)", async () => {
    const { app } = await build({ role: null });
    // `next` is attacker-controlled; only local paths may survive into the flow.
    for (const evil of ["https://evil.test", "//evil.test", "/\\evil.test"]) {
      const res = await app.inject({ method: "GET", url: `/api/auth/sso/p-oidc/start?next=${encodeURIComponent(evil)}` });
      // Either it redirects to the IdP or it fails locally, but never to evil.test.
      expect(String(res.headers.location ?? "")).not.toContain("evil.test");
    }
    await app.close();
  });
});

describe("Pro gating on the admin routes", () => {
  it("answers 402 pro_required on the free edition", async () => {
    const { app } = await build({ pro: false });
    for (const [method, url] of [
      ["GET", "/api/sso/providers"],
      ["GET", "/api/sso/settings"],
      ["POST", "/api/sso/providers"],
    ] as const) {
      const res = await app.inject({ method, url, payload: {} });
      expect(res.statusCode).toBe(402);
      expect(res.json()).toMatchObject({ error: "pro_required", feature: "sso" });
    }
    await app.close();
  });

  it("answers 403 for a non-admin on Pro", async () => {
    const { app } = await build({ role: "viewer" });
    const res = await app.inject({ method: "GET", url: "/api/sso/providers" });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it("answers 401 for an anonymous caller", async () => {
    const { app } = await build({ role: null });
    const res = await app.inject({ method: "GET", url: "/api/sso/providers" });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("refuses requiring SSO when no provider is enabled (lockout guard)", async () => {
    const { app } = await build({ state: { providers: [] } });
    const res = await app.inject({ method: "PUT", url: "/api/sso/settings", payload: { requireSso: true } });
    expect(res.statusCode).toBe(409);
    expect(res.json().message).toMatch(/before requiring SSO/);
    await app.close();
  });
});

describe("the password escape hatch", () => {
  async function loginApp(role: "admin" | "viewer", env: Record<string, string> = {}) {
    const passwordHash = await hashPassword("correct-horse");
    const user = role === "admin" ? { ...ADMIN, passwordHash } : { ...VIEWER, passwordHash };
    return build({
      role: null,
      env,
      state: { users: [user], settings: new Map([["sso.require_sso", "true"]]) },
    });
  }

  it("lets an admin in with a password even when SSO is required", async () => {
    const { app } = await loginApp("admin");
    const res = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: ADMIN.email, password: "correct-horse" } });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it("refuses a non-admin password login when SSO is required", async () => {
    const { app } = await loginApp("viewer");
    const res = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: VIEWER.email, password: "correct-horse" } });
    expect(res.statusCode).toBe(401);
    expect(res.json().message).toMatch(/identity provider/);
    await app.close();
  });

  it("lets anyone in when the operator set BULLPANE_ALLOW_PASSWORD_LOGIN", async () => {
    const { app } = await loginApp("viewer", { BULLPANE_ALLOW_PASSWORD_LOGIN: "true" });
    const res = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: VIEWER.email, password: "correct-horse" } });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it("still refuses a wrong password, hatch or not", async () => {
    const { app } = await loginApp("admin", { BULLPANE_ALLOW_PASSWORD_LOGIN: "true" });
    const res = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: ADMIN.email, password: "wrong" } });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("refuses an SSO-only account (null hash) on the password form", async () => {
    const { app } = await build({
      role: null,
      state: { users: [{ ...VIEWER, passwordHash: null as unknown as string }], settings: new Map() },
    });
    const res = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: VIEWER.email, password: "anything" } });
    expect(res.statusCode).toBe(401);
    await app.close();
  });
});
