/**
 * The free edition has no login: `authPlugin` puts a synthetic anonymous admin
 * on requests that arrive without a session, and every role guard keeps
 * working. The inverse matters more — unlocking `users` must bring the 401s
 * back on the very next request, with no restart.
 */
import { ANONYMOUS_USER_ID, anonymousUser, isAnonymousUser, type Edition } from "@bullpane/shared";
import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import { describe, expect, it } from "vitest";
import { authPlugin } from "../auth/plugin";
import { requireAuth, requireRole } from "../auth/guards";
import { buildEdition } from "../services/edition";

const FREE = buildEdition({ demoMode: false, checkoutUrl: "" }, null);
/** demoMode unlocks every feature, which is the shape of a licensed install. */
const PRO = buildEdition({ demoMode: true, checkoutUrl: "" }, null);

interface Harness {
  app: FastifyInstance;
  setEdition: (edition: Edition) => void;
}

async function harness(initial: Edition): Promise<Harness> {
  let edition = initial;
  const app = Fastify();
  await app.register(cookie, { secret: "a".repeat(32) });
  app.decorate("ctx", {
    edition: { getEdition: () => edition },
    sessions: { resolve: async () => null },
  } as never);
  await app.register(authPlugin);
  app.get("/who", async (request) => ({
    user: request.user ? { id: request.user.id, role: request.user.role } : null,
  }));
  app.get("/viewer", { preHandler: [requireRole("viewer")] }, async () => ({ ok: true }));
  app.get("/admin", { preHandler: [requireRole("admin")] }, async () => ({ ok: true }));
  app.get("/authed", { preHandler: [requireAuth] }, async () => ({ ok: true }));
  await app.ready();
  return { app, setEdition: (e) => { edition = e; } };
}

describe("free edition without login", () => {
  it("gives an anonymous admin to a request with no session", async () => {
    const { app } = await harness(FREE);
    const res = await app.inject({ method: "GET", url: "/who" });
    expect(res.json()).toEqual({ user: { id: ANONYMOUS_USER_ID, role: "admin" } });
    await app.close();
  });

  it("lets that user through every role guard, so no route needs to know", async () => {
    const { app } = await harness(FREE);
    for (const url of ["/authed", "/viewer", "/admin"]) {
      expect((await app.inject({ method: "GET", url })).statusCode).toBe(200);
    }
    await app.close();
  });

  it("refuses the same requests once a license unlocks users", async () => {
    const { app } = await harness(PRO);
    for (const url of ["/authed", "/viewer", "/admin"]) {
      expect((await app.inject({ method: "GET", url })).statusCode).toBe(401);
    }
    await app.close();
  });

  it("switches the moment the edition changes, without a restart", async () => {
    const { app, setEdition } = await harness(FREE);
    expect((await app.inject({ method: "GET", url: "/admin" })).statusCode).toBe(200);
    // A key was pasted: accounts exist now.
    setEdition(PRO);
    expect((await app.inject({ method: "GET", url: "/admin" })).statusCode).toBe(401);
    // ...and the licence lapsed back to free.
    setEdition(FREE);
    expect((await app.inject({ method: "GET", url: "/admin" })).statusCode).toBe(200);
    await app.close();
  });

  it("ignores a forged session cookie instead of trusting it", async () => {
    const { app } = await harness(FREE);
    const res = await app.inject({ method: "GET", url: "/who", cookies: { bullpane_session: "not-a-signed-value" } });
    // Unsigned/unknown cookie → still anonymous, never a resolved user.
    expect(res.json()).toEqual({ user: { id: ANONYMOUS_USER_ID, role: "admin" } });
    await app.close();
  });
});

describe("anonymous user helpers", () => {
  it("recognises the synthetic user and nothing else", () => {
    expect(isAnonymousUser(anonymousUser())).toBe(true);
    expect(isAnonymousUser({ id: "u1" })).toBe(false);
    expect(isAnonymousUser(null)).toBe(false);
    expect(isAnonymousUser(undefined)).toBe(false);
  });

  it("is an admin with no email, so nothing can log in as it", () => {
    const u = anonymousUser();
    expect(u.role).toBe("admin");
    expect(u.email).toBe("");
    expect(u.lastLoginAt).toBeNull();
  });
});
