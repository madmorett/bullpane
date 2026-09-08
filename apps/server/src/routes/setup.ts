import { type MeResponse, type SetupStatus, setupSchema } from "@bullpane/shared";
import type { FastifyInstance } from "fastify";
import { SESSION_COOKIE, sessionCookieOptions } from "../auth/sessions";
import { conflict } from "../plugins/errors";
import { assertFeature, blockInDemo } from "../plugins/gates";

export async function setupRoutes(app: FastifyInstance): Promise<void> {
  app.get("/setup/status", async (): Promise<SetupStatus> => {
    const authRequired = app.ctx.edition.getEdition().features.users;
    return {
      // Only asked on an edition that HAS accounts. On free the web never
      // routes to /setup, so answering true there would strand the UI on a
      // form whose POST is refused below.
      needsSetup: authRequired && (await app.ctx.users.count()) === 0,
      demo: app.ctx.config.demoMode,
      authRequired,
    };
  });

  app.post("/setup", { preHandler: [blockInDemo] }, async (request, reply): Promise<MeResponse> => {
    const input = setupSchema.parse(request.body);
    // The free edition has no login, so it has no first admin to create.
    assertFeature(app.ctx.edition.getEdition(), "users");
    if ((await app.ctx.users.count()) > 0) throw conflict("Setup already completed. Log in instead.");
    const user = await app.ctx.users.create({ ...input, role: "admin" });
    const session = await app.ctx.sessions.create(user.id);
    await app.ctx.users.touchLogin(user.id);
    reply.setCookie(SESSION_COOKIE, session.id, sessionCookieOptions(app.ctx.config, session.expiresAt));
    request.log.info({ userId: user.id }, "initial admin created");
    return { user: { ...user, lastLoginAt: new Date().toISOString() }, edition: app.ctx.edition.getEdition() };
  });
}
