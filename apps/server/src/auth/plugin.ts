/**
 * Resolves the session cookie into `request.user` for every request in the
 * scope it is registered in (the /api plugin).
 */
import type { FastifyInstance } from "fastify";
import { SESSION_COOKIE } from "./sessions";

export async function authPlugin(app: FastifyInstance): Promise<void> {
  // Registered from apiPlugin. The hook and decorators below must apply to the
  // sibling route plugins, so encapsulation is disabled via skip-override
  // (same mechanism fastify-plugin uses, without the extra dependency).
  app.decorateRequest("user", null);
  app.decorateRequest("sessionId", null);

  app.addHook("onRequest", async (request) => {
    const raw = request.cookies[SESSION_COOKIE];
    if (!raw) return;
    const unsigned = request.unsignCookie(raw);
    if (!unsigned.valid || !unsigned.value) return;
    const user = await app.ctx.sessions.resolve(unsigned.value);
    if (user) {
      request.user = user;
      request.sessionId = unsigned.value;
    }
  });
}

// Break Fastify encapsulation so `onRequest` + `request.user` reach every /api route.
(authPlugin as unknown as Record<symbol, boolean>)[Symbol.for("skip-override")] = true;
