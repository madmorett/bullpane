import { cleanQueueSchema, listSchedulersQuerySchema, type QueueSetup, type QueueSummary, type SchedulersPage } from "@bullmq-visualizer/shared";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireRole } from "../auth/guards";
import { notFound } from "../plugins/errors";
import { withRedis } from "../services/inspector-errors";
import { pageToRange } from "./jobs";

type QueueParams = { Params: { id: string; queue: string } };

const retryAllSchema = z.object({ state: z.enum(["failed", "completed"]) });
const drainSchema = z.object({ includeDelayed: z.boolean().optional() }).default({});

export async function queueRoutes(app: FastifyInstance): Promise<void> {
  const viewer = requireRole("viewer");
  const operator = requireRole("operator");
  const admin = requireRole("admin");
  const base = "/connections/:id/queues/:queue";

  app.get<QueueParams>(base, { preHandler: [viewer] }, async (request): Promise<QueueSummary> => {
    const { id, queue } = request.params;
    const row = await app.ctx.connections.getRow(id);
    const inspector = app.ctx.connections.inspectorFor(row);
    const stats = await withRedis(() => inspector.getQueueStats([queue], { withMetrics: true }));
    const s = stats[queue];
    if (!s) throw notFound("Queue");
    const summary: QueueSummary = {
      name: queue,
      prefix: row.prefix,
      counts: s.counts,
      isPaused: s.isPaused,
      isPro: s.isPro,
      groupsCount: s.groupsCount,
      schedulersCount: s.schedulersCount,
      stalledCount: s.stalledCount,
      rates: s.rates,
    };
    if (s.metrics) summary.metrics = s.metrics;
    return summary;
  });

  app.get<QueueParams>(`${base}/setup`, { preHandler: [viewer] }, async (request): Promise<QueueSetup> => {
    const inspector = await app.ctx.connections.getInspector(request.params.id);
    return withRedis(() => inspector.getQueueSetup(request.params.queue));
  });

  /**
   * Job schedulers ("repeatable jobs"). They live in the `repeat` zset, not in any
   * of the 8 states, so without this route they are invisible in the dashboard.
   * One EVALSHA (getSchedulers.lua), paged.
   */
  app.get<QueueParams>(`${base}/schedulers`, { preHandler: [viewer] }, async (request): Promise<SchedulersPage> => {
    const query = listSchedulersQuerySchema.parse(request.query);
    const inspector = await app.ctx.connections.getInspector(request.params.id);
    const { start, end } = pageToRange(query.page, query.pageSize);
    const { schedulers, total } = await withRedis(() => inspector.getSchedulers(request.params.queue, { start, end }));
    return { schedulers, total, start, end };
  });

  /**
   * Removing a scheduler also drops the delayed job it had already queued — that
   * is why it goes through bullmq's own removeJobScheduler and not a hand-written
   * DEL. In global read-only mode the `blockWrites` hook refuses this before it lands.
   */
  app.delete<{ Params: { id: string; queue: string; key: string } }>(
    `${base}/schedulers/:key`,
    { preHandler: [operator] },
    async (request): Promise<{ ok: true }> => {
      const inspector = await app.ctx.connections.getInspector(request.params.id);
      const { removed } = await withRedis(() => inspector.removeScheduler(request.params.queue, request.params.key));
      if (!removed) throw notFound("Job scheduler");
      request.auditDetail({ schedulerKey: request.params.key });
      request.log.info({ queue: request.params.queue, scheduler: request.params.key, by: request.user?.id }, "job scheduler removed");
      return { ok: true };
    },
  );

  app.post<QueueParams>(`${base}/pause`, { preHandler: [operator] }, async (request) => {
    const inspector = await app.ctx.connections.getInspector(request.params.id);
    await withRedis(() => inspector.pauseQueue(request.params.queue));
    request.log.info({ queue: request.params.queue, by: request.user?.id }, "queue paused");
    return { ok: true };
  });

  app.post<QueueParams>(`${base}/resume`, { preHandler: [operator] }, async (request) => {
    const inspector = await app.ctx.connections.getInspector(request.params.id);
    await withRedis(() => inspector.resumeQueue(request.params.queue));
    request.log.info({ queue: request.params.queue, by: request.user?.id }, "queue resumed");
    return { ok: true };
  });

  app.post<QueueParams>(`${base}/clean`, { preHandler: [operator] }, async (request): Promise<{ removed: number }> => {
    const input = cleanQueueSchema.parse(request.body ?? {});
    const inspector = await app.ctx.connections.getInspector(request.params.id);
    const result = await withRedis(() => inspector.cleanQueue(request.params.queue, input.state, input.grace, input.limit));
    // The hook cannot know "3,412 jobs went"; only the handler can.
    request.auditDetail({ state: input.state, grace: input.grace, limit: input.limit, removed: result.removed });
    request.log.info({ queue: request.params.queue, state: input.state, removed: result.removed, by: request.user?.id }, "queue cleaned");
    return { removed: result.removed };
  });

  app.post<QueueParams>(`${base}/retry-all`, { preHandler: [operator] }, async (request) => {
    const input = retryAllSchema.parse(request.body);
    const inspector = await app.ctx.connections.getInspector(request.params.id);
    await withRedis(() => inspector.retryAll(request.params.queue, input.state));
    request.auditDetail({ state: input.state });
    request.log.info({ queue: request.params.queue, state: input.state, by: request.user?.id }, "retry-all");
    return { ok: true };
  });

  app.post<QueueParams>(`${base}/drain`, { preHandler: [admin] }, async (request) => {
    const input = drainSchema.parse(request.body ?? {});
    const inspector = await app.ctx.connections.getInspector(request.params.id);
    await withRedis(() => inspector.drainQueue(request.params.queue, input.includeDelayed === true));
    request.auditDetail({ includeDelayed: input.includeDelayed === true });
    request.log.warn({ queue: request.params.queue, includeDelayed: input.includeDelayed === true, by: request.user?.id }, "queue drained");
    return { ok: true };
  });

  app.post<QueueParams>(`${base}/obliterate`, { preHandler: [admin] }, async (request) => {
    const inspector = await app.ctx.connections.getInspector(request.params.id);
    await withRedis(() => inspector.obliterateQueue(request.params.queue));
    app.ctx.flows.invalidate(request.params.id);
    request.log.warn({ queue: request.params.queue, by: request.user?.id }, "queue obliterated");
    return { ok: true };
  });
}
