/**
 * The /api plugin: session resolution + every resource router.
 * Encapsulated so the auth hook never runs for static assets.
 */
import type { FastifyInstance } from "fastify";
import { authPlugin } from "../auth/plugin";
import { blockWrites } from "../plugins/gates";
import { alertRoutes } from "./alerts";
import { authRoutes } from "./auth";
import { connectionRoutes } from "./connections";
import { flowRoutes } from "./flows";
import { folderRoutes } from "./folders";
import { groupRoutes } from "./groups";
import { healthRoutes } from "./health";
import { jobRoutes } from "./jobs";
import { licenseRoutes } from "./license";
import { queueRoutes } from "./queues";
import { setupRoutes } from "./setup";
import { userRoutes } from "./users";

export async function apiPlugin(app: FastifyInstance): Promise<void> {
  await app.register(authPlugin);

  // Read-only mode is enforced here, once, for every /api route: a single
  // choke point beats remembering to gate each mutating handler.
  app.addHook("onRequest", blockWrites);

  app.setNotFoundHandler(async (request, reply) => {
    void reply.status(404).send({ error: "not_found", message: `Route ${request.method} ${request.url} not found` });
  });

  await app.register(healthRoutes);
  await app.register(setupRoutes);
  await app.register(authRoutes);
  await app.register(licenseRoutes);
  await app.register(connectionRoutes);
  await app.register(queueRoutes);
  await app.register(jobRoutes);
  await app.register(groupRoutes);
  await app.register(flowRoutes);
  await app.register(folderRoutes);
  await app.register(alertRoutes);
  await app.register(userRoutes);
}
