import type { ConnectionHealth } from "@bullmq-visualizer/shared";
import type { FastifyInstance } from "fastify";
import { requireRole } from "../auth/guards";

export async function healthRoutes(app: FastifyInstance): Promise<void> {
  app.get("/health", async () => ({
    ok: true,
    version: app.ctx.version,
    uptime: Math.round(process.uptime()),
  }));

  /**
   * Live Redis health for every connection. This is what the homepage monitor
   * polls while someone is trialling the dashboard against production: one INFO
   * per connection, rate-limited and shared server-side (see services/health.ts).
   */
  app.get("/health/connections", { preHandler: [requireRole("viewer")] }, async (): Promise<ConnectionHealth[]> => {
    return app.ctx.health.listAll();
  });

  app.get<{ Params: { id: string } }>(
    "/health/connections/:id",
    { preHandler: [requireRole("viewer")] },
    async (request): Promise<ConnectionHealth> => app.ctx.health.getById(request.params.id),
  );
}