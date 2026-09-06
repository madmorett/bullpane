import { type Alert, type AlertEvent, createAlertSchema, updateAlertSchema } from "@bullmq-visualizer/shared";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { DeliveryResult } from "../alerts/deliver";
import { requireAuth, requireRole } from "../auth/guards";
import { requireFeature } from "../plugins/gates";

type IdParams = { Params: { id: string } };

const eventsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(1000).default(100),
  alertId: z.string().optional(),
});

export async function alertRoutes(app: FastifyInstance): Promise<void> {
  const gate = requireFeature("alerts");
  const viewer = [requireAuth, gate, requireRole("viewer")];
  const operator = [requireAuth, gate, requireRole("operator")];

  app.get("/alerts", { preHandler: viewer }, async (): Promise<Alert[]> => app.ctx.alerts.list());

  // Static segment beats the :id param in Fastify's router, so this is safe to register alongside /alerts/:id.
  app.get("/alerts/events", { preHandler: viewer }, async (request): Promise<AlertEvent[]> => {
    const query = eventsQuerySchema.parse(request.query);
    return app.ctx.alerts.listEvents({ limit: query.limit, alertId: query.alertId || undefined });
  });

  app.post("/alerts", { preHandler: operator }, async (request, reply): Promise<Alert> => {
    const input = createAlertSchema.parse(request.body);
    const alert = await app.ctx.alerts.create(input);
    reply.status(201);
    return alert;
  });

  app.patch<IdParams>("/alerts/:id", { preHandler: operator }, async (request): Promise<Alert> => {
    const input = updateAlertSchema.parse(request.body);
    return app.ctx.alerts.update(request.params.id, input);
  });

  app.delete<IdParams>("/alerts/:id", { preHandler: operator }, async (request) => {
    await app.ctx.alerts.remove(request.params.id);
    return { ok: true };
  });

  app.post<IdParams>(
    "/alerts/:id/test",
    { preHandler: operator },
    async (request): Promise<{ ok: boolean; results: DeliveryResult[] }> => {
      const row = await app.ctx.alerts.getRow(request.params.id);
      const results = await app.ctx.alertsEngine.sendTest(row);
      return { ok: results.every((r) => r.ok), results };
    },
  );
}
