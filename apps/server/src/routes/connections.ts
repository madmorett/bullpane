import {
  type ConnectionStatus,
  createConnectionSchema,
  type QueueSummary,
  type RedisConnection,
  type RedisServerInfo,
  testConnectionSchema,
  updateConnectionSchema,
} from "@bullmq-visualizer/shared";
import type { PingResult } from "@bullmq-visualizer/redis-inspector";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireRole } from "../auth/guards";
import { blockInDemo } from "../plugins/gates";
import { withRedis } from "../services/inspector-errors";

type IdParams = { Params: { id: string } };

const queuesQuerySchema = z.object({ refresh: z.string().optional() });

export async function connectionRoutes(app: FastifyInstance): Promise<void> {
  const viewer = requireRole("viewer");
  const admin = requireRole("admin");

  app.get("/connections", { preHandler: [viewer] }, async (): Promise<RedisConnection[]> => app.ctx.connections.list());

  app.post("/connections", { preHandler: [admin, blockInDemo] }, async (request, reply): Promise<RedisConnection> => {
    const input = createConnectionSchema.parse(request.body);
    const created = await app.ctx.connections.create(input);
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
    async (request): Promise<{ info: RedisServerInfo; queues: QueueSummary[]; status: ConnectionStatus }> => {
      const row = await app.ctx.connections.getRow(request.params.id);
      const inspector = app.ctx.connections.inspectorFor(row);
      const [info, queues, status] = await Promise.all([
        withRedis(() => inspector.serverInfo()),
        app.ctx.connections.listQueues(row),
        app.ctx.connections.getStatus(row),
      ]);
      return { info, queues, status };
    },
  );

  app.get<IdParams>("/connections/:id/queues", { preHandler: [viewer] }, async (request): Promise<QueueSummary[]> => {
    const query = queuesQuerySchema.parse(request.query);
    const row = await app.ctx.connections.getRow(request.params.id);
    const refresh = query.refresh === "1" || query.refresh === "true";
    return app.ctx.connections.listQueues(row, { refresh });
  });
}
