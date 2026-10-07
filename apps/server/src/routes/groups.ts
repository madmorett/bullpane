import type { DelayedGroupsPage, GroupsResponse, JobsPage } from "@bullpane/shared";
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
  const operator = requireRole("operator");
  const admin = requireRole("admin");
  const base = "/connections/:id/queues/:queue/groups";

  app.get<QueueParams>(base, { preHandler: [viewer] }, async (request): Promise<GroupsResponse> => {
    const query = pagingSchema.parse(request.query);
    const inspector = await app.ctx.connections.getInspector(request.params.id);
    const { start, end } = pageToRange(query.page, query.pageSize);
    const page = await withRedis(() => inspector.getGroups(request.params.queue, { start, end }));
    return { ...page, bullmqProApi: inspector.bullmqProApi };
  });

  // Groups with delayed jobs (BullMQ Pro indexes none of them). Not `/groups/delayed`:
  // "delayed" is a valid group id, and its page lives at `/groups/:groupId`.
  app.get<QueueParams>(`${base}-delayed`, { preHandler: [viewer] }, async (request): Promise<DelayedGroupsPage> => {
    // "<score>:<jobId>" of the last job read
    const query = z.object({ cursor: z.string().max(300).regex(/^[^:]+:.+$/).optional() }).parse(request.query);
    const inspector = await app.ctx.connections.getInspector(request.params.id);
    return withRedis(() => inspector.getDelayedGroups(request.params.queue, { cursor: query.cursor ?? null }));
  });

  app.get<GroupParams>(`${base}/:groupId/jobs`, { preHandler: [viewer] }, async (request): Promise<JobsPage> => {
    const query = pagingSchema.parse(request.query);
    const inspector = await app.ctx.connections.getInspector(request.params.id);
    const { start, end } = pageToRange(query.page, query.pageSize);
    return withRedis(() => inspector.getGroupJobs(request.params.queue, request.params.groupId, { start, end }));
  });

  // BullMQ Pro's own group operations (QueuePro). Without its package the inspector
  // answers 409 bullmq_pro_api_required. Drain deletes jobs, so it is admin, like
  // draining a queue; pause and resume are operator, like the queue's.
  app.post<GroupParams>(`${base}/:groupId/pause`, { preHandler: [operator] }, async (request) => {
    const inspector = await app.ctx.connections.getInspector(request.params.id);
    await withRedis(() => inspector.pauseGroup(request.params.queue, request.params.groupId));
    request.auditDetail({ groupId: request.params.groupId });
    request.log.info({ queue: request.params.queue, groupId: request.params.groupId, by: request.user?.id }, "group paused");
    return { ok: true };
  });

  app.post<GroupParams>(`${base}/:groupId/resume`, { preHandler: [operator] }, async (request) => {
    const inspector = await app.ctx.connections.getInspector(request.params.id);
    await withRedis(() => inspector.resumeGroup(request.params.queue, request.params.groupId));
    request.auditDetail({ groupId: request.params.groupId });
    request.log.info({ queue: request.params.queue, groupId: request.params.groupId, by: request.user?.id }, "group resumed");
    return { ok: true };
  });

  app.post<GroupParams>(`${base}/:groupId/drain`, { preHandler: [admin] }, async (request) => {
    const inspector = await app.ctx.connections.getInspector(request.params.id);
    await withRedis(() => inspector.drainGroup(request.params.queue, request.params.groupId));
    request.auditDetail({ groupId: request.params.groupId });
    request.log.warn({ queue: request.params.queue, groupId: request.params.groupId, by: request.user?.id }, "group drained");
    return { ok: true };
  });
}
