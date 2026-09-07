import { loginSchema, type MeResponse } from "@bullpane/shared";
import type { FastifyInstance } from "fastify";
import { requireAuth } from "../auth/guards";
import { verifyPassword } from "../auth/password";
import { SESSION_COOKIE, sessionCookieOptions, toUserDto } from "../auth/sessions";
import { unauthenticated } from "../plugins/errors";

export async function authRoutes(app: FastifyInstance): Promise<void> {
  app.post("/auth/login", async (request, reply): Promise<MeResponse> => {
    const input = loginSchema.parse(request.body);
    const row = await app.ctx.users.findByEmail(input.email);
    const ok = row ? await verifyPassword(input.password, row.passwordHash) : false;
    if (!row || !ok) {
      /**
       * A failed login is a security signal, so it is recorded as its own
       * action rather than as an errored `auth.login`. `request.user` is null
       * here (there is no session), so the attempted email is the only thing
       * identifying the attempt — it goes in `detail`, never the password.
       * Whether the email exists is deliberately NOT recorded: the row would
       * turn the audit log into an account enumeration oracle.
       */
      request.auditTarget({ action: "auth.login_failed" });
      request.auditDetail({ email: input.email });
      request.log.info({ email: input.email }, "login failed");
      throw unauthenticated("Email or password is incorrect");
    }
    const now = new Date();
    const session = await app.ctx.sessions.create(row.id, now);
    await app.ctx.users.touchLogin(row.id, now);
    reply.setCookie(SESSION_COOKIE, session.id, sessionCookieOptions(app.ctx.config, session.expiresAt));
    // The audit hook reads the actor from `request.user`, which the session
    // cookie only populates on the NEXT request. Set it here so the login row
    // names the person who just logged in instead of being anonymous.
    const user = toUserDto({ ...row, lastLoginAt: now });
    request.user = user;
    return { user, edition: app.ctx.edition.getEdition() };
  });

  app.post("/auth/logout", { preHandler: [requireAuth] }, async (request, reply) => {
    if (request.sessionId) await app.ctx.sessions.destroy(request.sessionId);
    reply.clearCookie(SESSION_COOKIE, { ...sessionCookieOptions(app.ctx.config), signed: false });
    return { ok: true };
  });

  app.get("/auth/me", { preHandler: [requireAuth] }, async (request): Promise<MeResponse> => {
    return { user: request.user as NonNullable<typeof request.user>, edition: app.ctx.edition.getEdition() };
  });
}
