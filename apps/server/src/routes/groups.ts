import type { GroupSummary, JobsPage } from "@bullpane/shared";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireRole } from "../auth/guards";
import { withRedis } from "../services/inspector-errors";
import { pageToRange } from "./jobs";

type QueueParams = { Params: { id: string; queue: string } };
type GroupParams = { Params: { id: string; queue: string; groupId: string } };

const pagingSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(25),
});

export async function groupRoutes(app: FastifyInstance): Promise<void> {
  const viewer = requireRole("viewer");
  const base = "/connections/:id/queues/:queue/groups";

  app.get<QueueParams>(base, { preHandler: [viewer] }, async (request): Promise<{ groups: GroupSummary[]; total: number }> => {
    const query = pagingSchema.parse(request.query);
    const inspector = await app.ctx.connections.getInspector(request.params.id);
    const { start, end } = pageToRange(query.page, query.pageSize);
    return withRedis(() => inspector.getGroups(request.params.queue, { start, end }));
  });

  app.get<GroupParams>(`${base}/:groupId/jobs`, { preHandler: [viewer] }, async (request): Promise<JobsPage> => {
    const query = pagingSchema.parse(request.query);
    const inspector = await app.ctx.connections.getInspector(request.params.id);
    const { start, end } = pageToRange(query.page, query.pageSize);
    return withRedis(() => inspector.getGroupJobs(request.params.queue, request.params.groupId, { start, end }));
  });
}
