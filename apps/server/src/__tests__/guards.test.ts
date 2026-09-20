import type { Edition, User } from "@bullpane/shared";
import type { FastifyRequest } from "fastify";
import { describe, expect, it } from "vitest";
import { requireAuth, requireRole } from "../auth/guards";
import { HttpError } from "../plugins/errors";
import { assertFeature, blockInDemo, requireFeature } from "../plugins/gates";
import { buildEdition } from "../services/edition";

const user = (role: User["role"]): User => ({
  id: "u1",
  email: "u@example.test",
  name: "U",
  role,
  createdAt: new Date().toISOString(),
  lastLoginAt: null, disabledAt: null,
});

/** Minimal fake request: only what the guards read. */
function fakeRequest(opts: { user?: User | null; edition?: Edition; demoMode?: boolean }): FastifyRequest {
  const edition = opts.edition ?? buildEdition({ demoMode: false, checkoutUrl: "" }, null);
  return {
    user: opts.user ?? null,
    sessionId: null,
    server: { ctx: { edition: { getEdition: () => edition }, config: { demoMode: opts.demoMode ?? false } } },
  } as unknown as FastifyRequest;
}

async function status(fn: () => Promise<void>): Promise<number | "ok"> {
  try {
    await fn();
    return "ok";
  } catch (err) {
    if (err instanceof HttpError) return err.status;
    throw err;
  }
}

const FREE = buildEdition({ demoMode: false, checkoutUrl: "" }, null);
const PRO = buildEdition({ demoMode: true, checkoutUrl: "" }, null);

describe("requireAuth / requireRole", () => {
  it("401 without a user", async () => {
    expect(await status(() => requireAuth(fakeRequest({})))).toBe(401);
    expect(await status(() => requireRole("viewer")(fakeRequest({})))).toBe(401);
  });

  it("respects the role ladder admin > operator > viewer", async () => {
    expect(await status(() => requireRole("viewer")(fakeRequest({ user: user("viewer") })))).toBe("ok");
    expect(await status(() => requireRole("operator")(fakeRequest({ user: user("viewer") })))).toBe(403);
    expect(await status(() => requireRole("operator")(fakeRequest({ user: user("operator") })))).toBe("ok");
    expect(await status(() => requireRole("admin")(fakeRequest({ user: user("operator") })))).toBe(403);
    expect(await status(() => requireRole("admin")(fakeRequest({ user: user("admin") })))).toBe("ok");
    expect(await status(() => requireRole("viewer")(fakeRequest({ user: user("admin") })))).toBe("ok");
  });
});

describe("requireFeature", () => {
  it("402 with the feature name on the free edition", async () => {
    const req = fakeRequest({ user: user("admin"), edition: FREE });
    try {
      await requireFeature("alerts")(req, {} as never);
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(HttpError);
      const e = err as HttpError;
      expect(e.status).toBe(402);
      expect(e.toBody()).toEqual({ error: "pro_required", message: expect.stringContaining("alerts"), feature: "alerts" });
    }
  });

  it("passes on pro", async () => {
    expect(await status(() => requireFeature("flows")(fakeRequest({ user: user("viewer"), edition: PRO }), {} as never))).toBe("ok");
  });

  it("pro gate is independent of role: a viewer on free gets 402, not 403", async () => {
    const req = fakeRequest({ user: user("viewer"), edition: FREE });
    // Route order is [requireAuth, requireFeature, requireRole]; the gate throws first.
    expect(await status(() => requireAuth(req))).toBe("ok");
    expect(await status(() => requireFeature("users")(req, {} as never))).toBe(402);
  });

  it("assertFeature covers every pro feature", () => {
    for (const f of ["alerts", "users", "folders", "flows"] as const) {
      expect(() => assertFeature(FREE, f)).toThrow(HttpError);
      expect(() => assertFeature(PRO, f)).not.toThrow();
    }
  });
});

describe("blockInDemo", () => {
  it("423 in demo mode, passes otherwise", async () => {
    expect(await status(() => blockInDemo(fakeRequest({ demoMode: true }), {} as never))).toBe(423);
    expect(await status(() => blockInDemo(fakeRequest({ demoMode: false }), {} as never))).toBe("ok");
  });
});
