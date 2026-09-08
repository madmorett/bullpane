/**
 * Resolves the session cookie into `request.user` for every request in the
 * scope it is registered in (the /api plugin).
 *
 * On the FREE edition there is no login: a request without a valid session
 * gets the synthetic anonymous admin instead of nothing. That choice lives
 * here, in one hook, rather than in the ~40 `requireRole` preHandlers — a
 * route added later cannot forget it, and the guards stay a pure question
 * about roles.
 *
 * `users` is the feature that gates it (not `tier`), because "accounts and
 * roles exist" is exactly what it means: unlock users and the login page,
 * sessions and 401s all come back on the same request.
 */
import { anonymousUser } from "@bullpane/shared";
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
    if (raw) {
      const unsigned = request.unsignCookie(raw);
      if (unsigned.valid && unsigned.value) {
        const user = await app.ctx.sessions.resolve(unsigned.value);
        if (user) {
          request.user = user;
          request.sessionId = unsigned.value;
          return;
        }
      }
    }
    // No session. Free edition → anonymous admin; Pro → stay null and let the
    // guards answer 401.
    if (!app.ctx.edition.getEdition().features.users) request.user = anonymousUser();
  });
}

// Break Fastify encapsulation so `onRequest` + `request.user` reach every /api route.
(authPlugin as unknown as Record<symbol, boolean>)[Symbol.for("skip-override")] = true;
