import {
  addJobSchema,
  type JobDetail,
  type JobSearchResult,
  type JobsPage,
  listJobsQuerySchema,
  searchJobsQuerySchema,
} from "@bullmq-visualizer/shared";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireRole } from "../auth/guards";
import { notFound } from "../plugins/errors";
import { withRedis } from "../services/inspector-errors";

type QueueParams = { Params: { id: string; queue: string } };
type JobParams = { Params: { id: string; queue: string; jobId: string } };

const logsQuerySchema = z.object({
  start: z.coerce.number().int().min(0).default(0),
  end: z.coerce.number().int().min(-1).default(-1),
});

/** page/pageSize (1-based) → inclusive start/end offsets. */
export function pageToRange(page: number, pageSize: number): { start: number; end: number } {
  const start = (page - 1) * pageSize;
  return { start, end: start + pageSize - 1 };
}

export async function jobRoutes(app: FastifyInstance): Promise<void> {
  const viewer = requireRole("viewer");
  const operator = requireRole("operator");
  const base = "/connections/:id/queues/:queue/jobs";

  app.get<QueueParams>(base, { preHandler: [viewer] }, async (request): Promise<JobsPage> => {
    const query = listJobsQuerySchema.parse(request.query);
    const inspector = await app.ctx.connections.getInspector(request.params.id);
    const { start, end } = pageToRange(query.page, query.pageSize);
    // BullMQ Pro: a group's waiting list is its own key, so `state` does not apply.
    if (query.groupId) {
      const groupId = query.groupId;
      return withRedis(() => inspector.getGroupJobs(request.params.queue, groupId, { start, end }));
    }
    return withRedis(() => inspector.getJobs(request.params.queue, query.state, { start, end, order: query.order }));
  });

  app.get<QueueParams>(`${base}/search`, { preHandler: [viewer] }, async (request): Promise<JobSearchResult> => {
    const query = searchJobsQuerySchema.parse(request.query);
    const inspector = await app.ctx.connections.getInspector(request.params.id);
    return withRedis(() =>
      inspector.searchJobs(request.params.queue, query.state, query.q, { cursor: query.cursor ?? null, limit: query.limit }),
    );
  });

  app.post<QueueParams>(base, { preHandler: [operator] }, async (request, reply): Promise<{ id: string }> => {
    const input = addJobSchema.parse(request.body ?? {});
    const inspector = await app.ctx.connections.getInspector(request.params.id);
    const result = await withRedis(() => inspector.addJob(request.params.queue, input.name, input.data, input.opts));
    // Never log job data.
    request.log.info({ queue: request.params.queue, jobId: result.id, name: input.name, by: request.user?.id }, "job added");
    reply.status(201);
    return { id: result.id };
  });

  app.get<JobParams>(`${base}/:jobId`, { preHandler: [viewer] }, async (request): Promise<JobDetail> => {
    const inspector = await app.ctx.connections.getInspector(request.params.id);
    const job = await withRedis(() => inspector.getJob(request.params.queue, request.params.jobId));
    if (!job) throw notFound("Job");
    return job;
  });

  app.get<JobParams>(`${base}/:jobId/logs`, { preHandler: [viewer] }, async (request): Promise<{ logs: string[]; count: number }> => {
    const query = logsQuerySchema.parse(request.query);
    const inspector = await app.ctx.connections.getInspector(request.params.id);
    return withRedis(() => inspector.getJobLogs(request.params.queue, request.params.jobId, { start: query.start, end: query.end }));
  });

  app.delete<JobParams>(`${base}/:jobId`, { preHandler: [operator] }, async (request) => {
    const inspector = await app.ctx.connections.getInspector(request.params.id);
    await withRedis(() => inspector.removeJob(request.params.queue, request.params.jobId));
    request.log.info({ queue: request.params.queue, jobId: request.params.jobId, by: request.user?.id }, "job removed");
    return { ok: true };
  });

  app.post<JobParams>(`${base}/:jobId/retry`, { preHandler: [operator] }, async (request) => {
    const inspector = await app.ctx.connections.getInspector(request.params.id);
    await withRedis(() => inspector.retryJob(request.params.queue, request.params.jobId));
    request.log.info({ queue: request.params.queue, jobId: request.params.jobId, by: request.user?.id }, "job retried");
    return { ok: true };
  });

  app.post<JobParams>(`${base}/:jobId/promote`, { preHandler: [operator] }, async (request) => {
    const inspector = await app.ctx.connections.getInspector(request.params.id);
    await withRedis(() => inspector.promoteJob(request.params.queue, request.params.jobId));
    request.log.info({ queue: request.params.queue, jobId: request.params.jobId, by: request.user?.id }, "job promoted");
    return { ok: true };
  });

  app.post<JobParams>(`${base}/:jobId/discard`, { preHandler: [operator] }, async (request) => {
    const inspector = await app.ctx.connections.getInspector(request.params.id);
    await withRedis(() => inspector.discardJob(request.params.queue, request.params.jobId));
    request.log.info({ queue: request.params.queue, jobId: request.params.jobId, by: request.user?.id }, "job discarded");
    return { ok: true };
  });
}
