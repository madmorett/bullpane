/**
 * Settings → MCP and the consent screen. The OAuth endpoints and /mcp itself are
 * root routes (ee/mcp/routes.ts); these are the ones the dashboard calls, with
 * the session cookie like every other /api route.
 *
 *   GET    /mcp/settings        any user   the endpoint to paste + the admin's ceiling
 *   PUT    /mcp/settings        admin      the ceiling: off | read | write
 *   GET    /mcp/grants          any user   own connected clients (?all=1: everyone's, admin)
 *   DELETE /mcp/grants/:id      own/admin  disconnect a client
 *   GET    /mcp/consent         any user   what the consent screen shows
 *   POST   /mcp/consent         any user   approve / decline → where the browser goes next
 */
import {
  mcpConsentDecisionSchema,
  updateMcpSettingsSchema,
  type McpConsentDecision,
  type McpConsentInfo,
  type McpGrant,
  type McpSettings,
} from "@bullpane/shared";
import type { FastifyInstance } from "fastify";
import { requireAuth, requireRole } from "../../auth/guards";
import { HttpError, notFound } from "../../plugins/errors";
import { blockInDemo, requireFeature } from "../../plugins/gates";
import { OAuthError } from "../mcp/service";

/** An OAuth failure on the consent screen is a 400 the page shows, not a 500. */
async function asApiError<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof OAuthError) throw new HttpError(400, err.error, err.message);
    throw err;
  }
}

export async function mcpRoutes(app: FastifyInstance): Promise<void> {
  // Pro gate before the role check (docs/API.md): a viewer on free sees the upsell.
  const pro = requireFeature("mcp");
  const anyUser = [pro, requireAuth];

  app.get("/mcp/settings", { preHandler: anyUser }, async (): Promise<McpSettings> => app.ctx.mcp.getSettings());

  app.put("/mcp/settings", { preHandler: [pro, requireRole("admin"), blockInDemo] }, async (request): Promise<McpSettings> => {
    const input = updateMcpSettingsSchema.parse(request.body ?? {});
    const before = await app.ctx.mcp.getMaxAccess();
    request.auditDetail({ from: before, to: input.maxAccess });
    return app.ctx.mcp.setMaxAccess(input.maxAccess);
  });

  app.get<{ Querystring: { all?: string } }>("/mcp/grants", { preHandler: anyUser }, async (request): Promise<McpGrant[]> =>
    app.ctx.mcp.listGrants(request.user!, request.query.all === "1"),
  );

  app.delete<{ Params: { id: string } }>("/mcp/grants/:id", { preHandler: anyUser }, async (request) => {
    const revoked = await app.ctx.mcp.revokeGrant(request.params.id, request.user!);
    if (!revoked) throw notFound("Connected client");
    request.auditDetail({ client: revoked.clientName, of: revoked.userEmail, access: revoked.access });
    return { ok: true };
  });

  app.get<{ Querystring: { request?: string } }>("/mcp/consent", { preHandler: anyUser }, async (request): Promise<McpConsentInfo> =>
    asApiError(() => app.ctx.mcp.consentInfo(request.query.request ?? "", request.user!)),
  );

  app.post("/mcp/consent", { preHandler: anyUser }, async (request): Promise<McpConsentDecision> => {
    const input = mcpConsentDecisionSchema.parse(request.body ?? {});
    const result = await asApiError(() => app.ctx.mcp.decide(input.request, request.user!, input.approve, input.access));
    // Approved or not, the row says which client asked: a refusal is a finding too.
    request.auditDetail({ client: result.clientName, approved: result.access !== null, ...(result.access ? { access: result.access } : {}) });
    return { redirectTo: result.redirectTo };
  });
}
