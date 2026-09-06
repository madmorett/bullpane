import type { Edition } from "@bullmq-visualizer/shared";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireRole } from "../auth/guards";
import { blockInDemo } from "../plugins/gates";

const putLicenseSchema = z.object({ key: z.string().min(1).max(8192) });

export async function licenseRoutes(app: FastifyInstance): Promise<void> {
  // Public: the login page shows the tier.
  app.get("/edition", async (): Promise<Edition> => app.ctx.edition.getEdition());

  app.get("/license", { preHandler: [requireRole("admin")] }, async (): Promise<Edition> => app.ctx.edition.getEdition());

  app.put("/license", { preHandler: [requireRole("admin"), blockInDemo] }, async (request): Promise<Edition> => {
    const { key } = putLicenseSchema.parse(request.body);
    const edition = await app.ctx.edition.setLicenseKey(key);
    app.ctx.alertsEngine.start();
    return edition;
  });

  app.delete("/license", { preHandler: [requireRole("admin"), blockInDemo] }, async (): Promise<Edition> => {
    return app.ctx.edition.clearLicenseKey();
  });
}
