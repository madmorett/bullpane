import {
  addJobSchema,
  BULK_JOB_ACTIONS,
  bulkJobActionSchema,
  type BulkJobAction,
  type BulkJobActionResult,
  type JobDetail,
  type JobSearchResult,
  type JobsPage,
  listJobsQuerySchema,
  searchJobsQuerySchema,
} from "@bullpane/shared";
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
    // Never log job data — here or in the audit row. The audit `detail` gets the
    // job NAME, the resulting id and the payload SIZE; the payload itself would
    // put customer PII in a table admins can export as CSV.
    request.auditDetail({ name: input.name, dataBytes: JSON.stringify(input.data ?? null).length });
    request.auditTarget({ jobId: result.id });
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

  /**
   * Ações em lote: retry / remove / promote sobre uma lista de ids.
   *
   * Por que existem: entre "um job" e "todos os 1.000" não havia nada, e o caso
   * real é o do meio — as falhas vêm agrupadas (um webhook de um tenant
   * devolvendo 410), a busca server-side acha exatamente esses 50 e o operador
   * quer reprocessar esses e descartar os outros.
   *
   * Duas regras do contrato, iguais nas três rotas:
   *  - TETO de BULK_JOB_LIMIT ids por chamada, validado no zod (400 com a
   *    mensagem). Sem teto alguém cola 100 mil ids e prende o Redis.
   *  - RESULTADO PARCIAL com 200: `{ ok, failed }`. Um id podado ou em estado
   *    incompatível não derruba os outros 47, e o operador vê quais 3 falharam.
   */
  for (const action of BULK_JOB_ACTIONS) {
    app.post<QueueParams>(`${base}/bulk/${action}`, { preHandler: [operator] }, async (request): Promise<BulkJobActionResult> => {
      const input = bulkJobActionSchema.parse(request.body ?? {});
      const inspector = await app.ctx.connections.getInspector(request.params.id);
      const result = await withRedis(() =>
        inspector.bulkJobAction(request.params.queue, action as BulkJobAction, input.jobIds),
      );
      // Auditoria: só CONTAGENS e os ids, nunca o payload dos jobs (regra do
      // CLAUDE.md; `sanitizeDetail` também derrubaria `data`, mas o handler não
      // deve nem chegar perto). Os motivos das falhas são erros do BullMQ, não
      // dados do cliente, então cabem — limitados para a linha não explodir.
      request.auditDetail({
        requested: result.requested,
        ok: result.ok.length,
        failed: result.failed.length,
        ...(result.failed.length > 0 ? { reasons: result.failed.slice(0, 10).map((f) => `${f.jobId}: ${f.reason}`) } : {}),
      });
      request.log.info(
        { queue: request.params.queue, action, requested: result.requested, ok: result.ok.length, failed: result.failed.length, by: request.user?.id },
        "bulk job action",
      );
      return result;
    });
  }
}
