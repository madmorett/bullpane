/**
 * The /api plugin: session resolution + every resource router.
 * Encapsulated so the auth hook never runs for static assets.
 */
import type { FastifyInstance } from "fastify";
import { authPlugin } from "../auth/plugin";
import { registerAuditHook } from "../plugins/audit";
import { blockWrites } from "../plugins/gates";
import { alertRoutes } from "./alerts";
import { auditRoutes } from "./audit";
import { authRoutes } from "./auth";
import { authSsoRoutes } from "./auth-sso";
import { connectionRoutes } from "./connections";
import { flowRoutes } from "./flows";
import { folderRoutes } from "./folders";
import { groupRoutes } from "./groups";
import { healthRoutes } from "./health";
import { jobRoutes } from "./jobs";
import { licenseRoutes } from "./license";
import { queueRoutes } from "./queues";
import { settingsRoutes } from "./settings";
import { setupRoutes } from "./setup";
import { ssoRoutes } from "./sso";
import { userRoutes } from "./users";

export async function apiPlugin(app: FastifyInstance): Promise<void> {
  await app.register(authPlugin);

  // Read-only mode is enforced here, once, for every /api route: a single
  // choke point beats remembering to gate each mutating handler.
  app.addHook("onRequest", blockWrites);

  // Audit is the mirror image of blockWrites: one hook for the whole /api tree,
  // so a route added later cannot fall out of the trail by being forgotten.
  // See plugins/audit.ts for why this is a hook and not a call per handler.
  registerAuditHook(app);

  app.setNotFoundHandler(async (request, reply) => {
    void reply.status(404).send({ error: "not_found", message: `Route ${request.method} ${request.url} not found` });
  });

  await app.register(healthRoutes);
  await app.register(setupRoutes);
  await app.register(authRoutes);
  await app.register(authSsoRoutes);
  await app.register(ssoRoutes);
  await app.register(licenseRoutes);
  await app.register(connectionRoutes);
  await app.register(queueRoutes);
  await app.register(jobRoutes);
  await app.register(groupRoutes);
  await app.register(flowRoutes);
  await app.register(folderRoutes);
  await app.register(alertRoutes);
  await app.register(userRoutes);
  await app.register(auditRoutes);
  await app.register(settingsRoutes);
}
