import { createFolderSchema, type Folder, setFolderQueuesSchema, updateFolderSchema } from "@bullmq-visualizer/shared";
import type { FastifyInstance } from "fastify";
import { requireAuth, requireRole } from "../auth/guards";
import { requireFeature } from "../plugins/gates";

type IdParams = { Params: { id: string } };

export async function folderRoutes(app: FastifyInstance): Promise<void> {
  const gate = requireFeature("folders");
  const viewer = [requireAuth, gate, requireRole("viewer")];
  const operator = [requireAuth, gate, requireRole("operator")];

  app.get("/folders", { preHandler: viewer }, async (): Promise<Folder[]> => app.ctx.folders.list());

  app.post("/folders", { preHandler: operator }, async (request, reply): Promise<Folder> => {
    const input = createFolderSchema.parse(request.body);
    const folder = await app.ctx.folders.create(input);
    reply.status(201);
    return folder;
  });

  app.patch<IdParams>("/folders/:id", { preHandler: operator }, async (request): Promise<Folder> => {
    const input = updateFolderSchema.parse(request.body);
    return app.ctx.folders.update(request.params.id, input);
  });

  app.delete<IdParams>("/folders/:id", { preHandler: operator }, async (request) => {
    await app.ctx.folders.remove(request.params.id);
    return { ok: true };
  });

  app.put<IdParams>("/folders/:id/queues", { preHandler: operator }, async (request): Promise<Folder> => {
    const input = setFolderQueuesSchema.parse(request.body);
    return app.ctx.folders.setQueues(request.params.id, input.queues);
  });
}
