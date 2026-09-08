import {
  type DiscoveryStatus,
  type ConnectionStatus,
  createConnectionSchema,
  type HiddenQueue,
  hideQueueSchema,
  type QueueSummary,
  type RedisConnection,
  type RedisServerInfo,
  testConnectionSchema,
  updateConnectionSchema,
} from "@bullpane/shared";
import type { PingResult } from "@bullpane/redis-inspector";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireRole } from "../auth/guards";
import { blockInDemo } from "../plugins/gates";
import { withRedis } from "../services/inspector-errors";

type IdParams = { Params: { id: string } };
type HiddenQueueParams = { Params: { id: string; queueName: string } };

const queuesQuerySchema = z.object({ refresh: z.string().optional(), includeHidden: z.string().optional() });

const isTrue = (v: string | undefined) => v === "1" || v === "true";

export async function connectionRoutes(app: FastifyInstance): Promise<void> {
  const viewer = requireRole("viewer");
  // Hiding a queue is the same weight as pausing one: an operational choice that
  // changes what the team looks at but destroys nothing. Hence operator, not admin.
  const operator = requireRole("operator");
  const admin = requireRole("admin");

  app.get("/connections", { preHandler: [viewer] }, async (): Promise<RedisConnection[]> => app.ctx.connections.list());

  app.post("/connections", { preHandler: [admin, blockInDemo] }, async (request, reply): Promise<RedisConnection> => {
    const input = createConnectionSchema.parse(request.body);
    const created = await app.ctx.connections.create(input);
    // Name and prefix, never the URL: it carries the Redis password.
    request.auditTarget({ connectionId: created.id, connectionName: created.name });
    request.auditDetail({ prefix: created.prefix, cluster: created.cluster, queueFilter: created.queueFilter });
    reply.status(201);
    return created;
  });

  app.post("/connections/test", { preHandler: [admin] }, async (request): Promise<PingResult> => {
    const input = testConnectionSchema.parse(request.body);
    // Throwaway inspector keyed by a unique id so it never collides with a stored connection.
    const id = `test:${Date.now()}:${Math.random().toString(36).slice(2)}`;
    const inspector = app.ctx.pool.get({ id, url: input.url, prefix: input.prefix ?? "bull", cluster: input.cluster ?? false });
    try {
      return await inspector.ping();
    } catch (err) {
      return { ok: false, latencyMs: 0, redisVersion: null, error: err instanceof Error ? err.message : String(err) };
    } finally {
      await app.ctx.pool.evict(id).catch(() => undefined);
    }
  });

  app.patch<IdParams>("/connections/:id", { preHandler: [admin, blockInDemo] }, async (request): Promise<RedisConnection> => {
    const input = updateConnectionSchema.parse(request.body);
    const updated = await app.ctx.connections.update(request.params.id, input);
    // Which FIELDS changed, not their values (`url` holds the password).
    request.auditTarget({ connectionName: updated.name });
    request.auditDetail({ changed: Object.keys(input) });
    app.ctx.flows.invalidate(request.params.id);
    return updated;
  });

  app.delete<IdParams>("/connections/:id", { preHandler: [admin, blockInDemo] }, async (request) => {
    await app.ctx.connections.remove(request.params.id);
    app.ctx.flows.invalidate(request.params.id);
    return { ok: true };
  });

  app.get<IdParams>(
    "/connections/:id/overview",
    { preHandler: [viewer] },
    async (
      request,
    ): Promise<{ info: RedisServerInfo; queues: QueueSummary[]; status: ConnectionStatus; hiddenCount: number; discovery: DiscoveryStatus }> => {
      const row = await app.ctx.connections.getRow(request.params.id);
      const inspector = app.ctx.connections.inspectorFor(row);
      const [info, queues, status, hidden] = await Promise.all([
        withRedis(() => inspector.serverInfo()),
        // withMetrics comes back from the SAME Lua script in the same round trip
        // (an LRANGE of the metrics list), so the sparklines are free.
        app.ctx.connections.listQueues(row, { withMetrics: true }),
        app.ctx.connections.getStatus(row),
        // `queues` already excludes the hidden ones, so the aggregate strip can
        // sum what it is given and still say "N hidden" out loud.
        app.ctx.connections.hiddenQueueNames(row.id),
      ]);
      // After listQueues so it reflects the pass that just ran. On a huge keyspace
      // the first SCAN cycle takes several passes; the UI must say the list may be
      // incomplete rather than let "no queues" pass for the truth.
      const discovery = await inspector.discoveryStatus();
      return { info, queues, status, hiddenCount: hidden.size, discovery };
    },
  );

  app.get<IdParams>("/connections/:id/queues", { preHandler: [viewer] }, async (request): Promise<QueueSummary[]> => {
    const query = queuesQuerySchema.parse(request.query);
    const row = await app.ctx.connections.getRow(request.params.id);
    return app.ctx.connections.listQueues(row, {
      refresh: isTrue(query.refresh),
      withMetrics: true,
      includeHidden: isTrue(query.includeHidden),
    });
  });

  // -------------------------------------------------------------------------
  // Hidden queues. Reading is viewer (everyone should be able to see WHAT is
  // being hidden from them, and by whom); writing is operator. Global read-only
  // mode is already covered by the `blockWrites` hook in routes/index.ts, which
  // refuses every non-GET under /api, so POST/DELETE here need no extra gate.
  // -------------------------------------------------------------------------

  app.get<IdParams>("/connections/:id/hidden-queues", { preHandler: [viewer] }, async (request): Promise<HiddenQueue[]> => {
    await app.ctx.connections.getRow(request.params.id);
    return app.ctx.connections.listHiddenQueues(request.params.id);
  });

  app.post<IdParams>("/connections/:id/hidden-queues", { preHandler: [operator] }, async (request, reply): Promise<HiddenQueue[]> => {
    const input = hideQueueSchema.parse(request.body);
    const hidden = await app.ctx.connections.hideQueue(request.params.id, input.queueName, request.user?.id ?? null);
    // The queue name is in the BODY here, not in the route params.
    request.auditTarget({ queueName: input.queueName });
    request.log.info({ connectionId: request.params.id, queue: input.queueName, by: request.user?.id }, "queue hidden");
    reply.status(201);
    return hidden;
  });

  app.delete<HiddenQueueParams>("/connections/:id/hidden-queues/:queueName", { preHandler: [operator] }, async (request): Promise<HiddenQueue[]> => {
    const hidden = await app.ctx.connections.unhideQueue(request.params.id, request.params.queueName);
    request.log.info({ connectionId: request.params.id, queue: request.params.queueName, by: request.user?.id }, "queue unhidden");
    return hidden;
  });
}
