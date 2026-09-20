import { createUserSchema, updateUserSchema, type User } from "@bullpane/shared";
import type { FastifyInstance } from "fastify";
import { requireAuth, requireRole } from "../auth/guards";
import { SESSION_COOKIE, sessionCookieOptions } from "../auth/sessions";
import { blockInDemo, requireFeature } from "../plugins/gates";

type IdParams = { Params: { id: string } };

export async function userRoutes(app: FastifyInstance): Promise<void> {
  const gate = requireFeature("users");
  const admin = [requireAuth, gate, requireRole("admin")];
  const adminMutating = [...admin, blockInDemo];

  app.get("/users", { preHandler: admin }, async (): Promise<User[]> => app.ctx.users.list());

  app.post("/users", { preHandler: adminMutating }, async (request, reply): Promise<User> => {
    const input = createUserSchema.parse(request.body);
    const user = await app.ctx.users.create(input);
    // Email and role, never the password (the sanitiser drops it anyway).
    request.auditDetail({ userId: user.id, email: user.email, role: user.role });
    request.log.info({ userId: user.id, role: user.role, by: request.user?.id }, "user created");
    reply.status(201);
    return user;
  });

  app.patch<IdParams>("/users/:id", { preHandler: adminMutating }, async (request, reply): Promise<User> => {
    const input = updateUserSchema.parse(request.body);
    const actor = request.user as User;
    const before = await app.ctx.users.getRow(request.params.id);
    const user = await app.ctx.users.update(request.params.id, input, actor);
    const toggled = input.disabled !== undefined && input.disabled !== (before.disabledAt !== null);
    // Disabling is the event an auditor looks for; it gets its own action instead
    // of hiding inside "user.update changed: [disabled]".
    if (toggled) request.auditTarget({ action: input.disabled ? "user.disable" : "user.enable" });
    // "changed: [password]" is the finding; the new password is not.
    request.auditDetail({
      userId: user.id,
      email: user.email,
      changed: Object.keys(input),
      ...(input.role !== undefined ? { role: input.role } : {}),
    });
    if (toggled) request.log.info({ userId: user.id, disabled: input.disabled, by: actor.id }, input.disabled ? "user disabled" : "user enabled");
    if (input.password !== undefined || input.role !== undefined || input.disabled === true) {
      // Credentials, permissions or access changed: drop that user's sessions.
      await app.ctx.sessions.destroyForUser(user.id);
      if (user.id === actor.id) {
        // ...but keep the caller logged in with a fresh session.
        const session = await app.ctx.sessions.create(user.id);
        reply.setCookie(SESSION_COOKIE, session.id, sessionCookieOptions(app.ctx.config, session.expiresAt));
      }
    }
    return user;
  });

  // There is deliberately no DELETE /users/:id. Users are disabled through PATCH
  // { disabled: true } — see migrations/0007_user_disabled.sql for why.
}
