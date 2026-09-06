import { createFlowEdgeSchema, type FlowEdge, type FlowGraph } from "@bullmq-visualizer/shared";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireAuth, requireRole } from "../auth/guards";
import { requireFeature } from "../plugins/gates";

type IdParams = { Params: { id: string } };

const flowsQuerySchema = z.object({ sample: z.coerce.number().int().min(10).max(2000).default(200) });

export async function flowRoutes(app: FastifyInstance): Promise<void> {
  // Auth first (401), then the pro gate (402), then the role (403) — see docs/API.md.
  const gate = requireFeature("flows");
  const viewer = [requireAuth, gate, requireRole("viewer")];
  const operator = [requireAuth, gate, requireRole("operator")];

  app.get<IdParams>("/connections/:id/flows", { preHandler: viewer }, async (request): Promise<FlowGraph> => {
    const query = flowsQuerySchema.parse(request.query);
    return app.ctx.flows.getGraph(request.params.id, query.sample);
  });

  app.post("/flow-edges", { preHandler: operator }, async (request, reply): Promise<FlowEdge> => {
    const input = createFlowEdgeSchema.parse(request.body);
    const edge = await app.ctx.flows.createManualEdge(input);
    reply.status(201);
    return edge;
  });

  app.delete<IdParams>("/flow-edges/:id", { preHandler: operator }, async (request) => {
    await app.ctx.flows.deleteManualEdge(request.params.id);
    return { ok: true };
  });
}
