import { cleanQueueSchema, type QueueSetup, type QueueSummary } from "@bullmq-visualizer/shared";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireRole } from "../auth/guards";
import { notFound } from "../plugins/errors";
import { withRedis } from "../services/inspector-errors";

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
      rates: s.rates,
    };
    if (s.metrics) summary.metrics = s.metrics;
    return summary;
  });

  app.get<QueueParams>(`${base}/setup`, { preHandler: [viewer] }, async (request): Promise<QueueSetup> => {
    const inspector = await app.ctx.connections.getInspector(request.params.id);
    return withRedis(() => inspector.getQueueSetup(request.params.queue));
  });

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
    request.log.info({ queue: request.params.queue, state: input.state, removed: result.removed, by: request.user?.id }, "queue cleaned");
    return { removed: result.removed };
  });

  app.post<QueueParams>(`${base}/retry-all`, { preHandler: [operator] }, async (request) => {
    const input = retryAllSchema.parse(request.body);
    const inspector = await app.ctx.connections.getInspector(request.params.id);
    await withRedis(() => inspector.retryAll(request.params.queue, input.state));
    request.log.info({ queue: request.params.queue, state: input.state, by: request.user?.id }, "retry-all");
    return { ok: true };
  });

  app.post<QueueParams>(`${base}/drain`, { preHandler: [admin] }, async (request) => {
    const input = drainSchema.parse(request.body ?? {});
    const inspector = await app.ctx.connections.getInspector(request.params.id);
    await withRedis(() => inspector.drainQueue(request.params.queue, input.includeDelayed === true));
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
