import type { Edition } from "@bullpane/shared";
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
    // Who the key was issued to, never the key itself.
    request.auditDetail({ tier: edition.tier, licensee: edition.license?.licensee ?? null });
    app.ctx.alertsEngine.start();
    return edition;
  });

  app.delete("/license", { preHandler: [requireRole("admin"), blockInDemo] }, async (): Promise<Edition> => {
    return app.ctx.edition.clearLicenseKey();
  });

  // "Check now": contact the license server for a subscription key. Never
  // fails; the outcome is in `license.status` / `license.lastCheckError`.
  app.post("/license/refresh", { preHandler: [requireRole("admin"), blockInDemo] }, async (): Promise<Edition> => {
    const edition = await app.ctx.edition.refresh();
    if (edition.features.alerts) app.ctx.alertsEngine.start();
    return edition;
  });
}
