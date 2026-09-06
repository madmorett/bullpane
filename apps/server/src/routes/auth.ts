import { loginSchema, type MeResponse } from "@bullmq-visualizer/shared";
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
      request.log.info({ email: input.email }, "login failed");
      throw unauthenticated("Email or password is incorrect");
    }
    const now = new Date();
    const session = await app.ctx.sessions.create(row.id, now);
    await app.ctx.users.touchLogin(row.id, now);
    reply.setCookie(SESSION_COOKIE, session.id, sessionCookieOptions(app.ctx.config, session.expiresAt));
    return { user: toUserDto({ ...row, lastLoginAt: now }), edition: app.ctx.edition.getEdition() };
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
