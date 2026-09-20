/**
 * Global dashboard settings that are not a Pro feature.
 *
 * Attention thresholds are readable by anyone signed in — the Overview needs
 * them to render for every role — and writable by admins only, like every other
 * setting that changes what the whole team sees.
 */
import { attentionThresholdsSchema, type AttentionThresholds } from "@bullpane/shared";
import type { FastifyInstance } from "fastify";
import { requireAuth, requireRole } from "../auth/guards";

export async function settingsRoutes(app: FastifyInstance): Promise<void> {
  app.get("/settings/attention", { preHandler: [requireAuth] }, async (): Promise<AttentionThresholds> => app.ctx.attention.get());

  app.put(
    "/settings/attention",
    // Deliberately NOT blockInDemo: unlike a license key, a Redis connection or
    // a user, these two integers only change which cards the Overview shows.
    // Letting a demo visitor tune them is the point of the demo. Read-only mode
    // still refuses the write, through the global blockWrites hook.
    { preHandler: [requireAuth, requireRole("admin")] },
    async (request): Promise<AttentionThresholds> => {
      const input = attentionThresholdsSchema.parse(request.body);
      const saved = await app.ctx.attention.set(input);
      request.auditTarget({ action: "attention.thresholds_update" });
      request.auditDetail({ waitingAbove: saved.waitingAbove, failedAbove: saved.failedAbove });
      return saved;
    },
  );
}
