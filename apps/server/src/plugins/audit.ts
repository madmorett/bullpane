/**
 * Audit instrumentation. ONE global `onResponse` hook for the whole /api tree,
 * exactly like `blockWrites` in gates.ts is one choke point for read-only mode.
 *
 * WHY A HOOK AND NOT A CALL PER HANDLER (the decision, spelled out):
 *
 * The failure mode of per-handler calls is silent: someone adds
 * POST /connections/:id/queues/:queue/requeue-all in six months, forgets the
 * `audit.record(...)` line, and the trail has a hole nobody notices until an
 * auditor asks. A hook cannot be forgotten — a new route either matches the map
 * or shows up as `unmapped`, which is loud. The same argument that made
 * `blockWrites` a single hook applies here, and stronger: a missing audit row
 * is undetectable, while a missing gate at least fails closed.
 *
 * But a hook alone cannot see "3,412 jobs were cleaned" or "the job was named
 * send-invoice" — that lives inside the handler. So this is a HYBRID:
 *
 *   - the hook guarantees COVERAGE: it derives the action from method + route
 *     pattern, reads the actor from `request.user`, the target from the route
 *     params, and the result from the status code;
 *   - the handler ENRICHES via `request.auditDetail(...)` / `request.auditTarget(...)`,
 *     which merge into the row the hook is about to write. A handler that adds
 *     nothing still produces a complete row.
 *
 * Only mutating requests are recorded. GETs are excluded on purpose: the
 * dashboard polls /queues every 5 s per connection, so auditing reads would
 * write millions of rows saying nothing and bury the twelve that matter.
 *
 * Failures are recorded too (`result: "error"`, with the API error message).
 * "Someone tried to obliterate the payments queue and got a 403" is precisely
 * what an auditor wants to see, and it never appears in a success-only log.
 */
import type { AuditAction } from "@bullpane/shared";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

/** What a handler can add to the row the hook will write. */
export interface AuditPatch {
  connectionId?: string | null;
  connectionName?: string | null;
  queueName?: string | null;
  jobId?: string | null;
  detail?: Record<string, unknown> | null;
  /** override the derived action (login vs login_failed) */
  action?: AuditAction;
  /** skip the row entirely (e.g. a no-op idempotent call) */
  skip?: boolean;
}

declare module "fastify" {
  interface FastifyRequest {
    /** merged into the audit row by the onResponse hook. */
    auditPatch: AuditPatch | null;
    /** add action parameters — NEVER a job payload. */
    auditDetail(detail: Record<string, unknown>): void;
    /** name the thing that was acted on when the route params do not say it. */
    auditTarget(target: Omit<AuditPatch, "detail">): void;
    /** set by the error handler: `<error code>: <message>` of the API error. */
    auditError: string | null;
  }
}

/**
 * method + Fastify route pattern → action. The pattern (`request.routeOptions.url`)
 * is used rather than the raw URL so a queue called "pause" cannot fake a match
 * and so the map has one entry per route instead of one per queue name.
 */
const ROUTE_ACTIONS: Record<string, AuditAction> = {
  // jobs
  "POST /api/connections/:id/queues/:queue/jobs": "job.add",
  "DELETE /api/connections/:id/queues/:queue/jobs/:jobId": "job.remove",
  "POST /api/connections/:id/queues/:queue/jobs/:jobId/retry": "job.retry",
  "POST /api/connections/:id/queues/:queue/jobs/:jobId/promote": "job.promote",
  "POST /api/connections/:id/queues/:queue/jobs/:jobId/discard": "job.discard",
  // Ações em lote. Rotas separadas (e ações separadas no log) de propósito:
  // "reprocessou 50 jobs" e "reprocessou 1 job" são eventos diferentes para
  // quem audita, e o `detail` do handler traz pedidos/ok/falhas.
  "POST /api/connections/:id/queues/:queue/jobs/bulk/retry": "job.bulk_retry",
  "POST /api/connections/:id/queues/:queue/jobs/bulk/remove": "job.bulk_remove",
  "POST /api/connections/:id/queues/:queue/jobs/bulk/promote": "job.bulk_promote",
  // queues
  "POST /api/connections/:id/queues/:queue/pause": "queue.pause",
  "POST /api/connections/:id/queues/:queue/resume": "queue.resume",
  "POST /api/connections/:id/queues/:queue/clean": "queue.clean",
  "POST /api/connections/:id/queues/:queue/retry-all": "queue.retry_all",
  "POST /api/connections/:id/queues/:queue/drain": "queue.drain",
  "POST /api/connections/:id/queues/:queue/obliterate": "queue.obliterate",
  "DELETE /api/connections/:id/queues/:queue/schedulers/:key": "scheduler.remove",
  "POST /api/connections/:id/hidden-queues": "queue.hide",
  "DELETE /api/connections/:id/hidden-queues/:queueName": "queue.unhide",
  // connections
  "POST /api/connections": "connection.create",
  "PATCH /api/connections/:id": "connection.update",
  "DELETE /api/connections/:id": "connection.delete",
  // users
  "POST /api/users": "user.create",
  "PATCH /api/users/:id": "user.update",
  "DELETE /api/users/:id": "user.delete",
  // alerts
  "POST /api/alerts": "alert.create",
  "PATCH /api/alerts/:id": "alert.update",
  "DELETE /api/alerts/:id": "alert.delete",
  // license
  "PUT /api/license": "license.set",
  "DELETE /api/license": "license.remove",
  // auth. login → login_failed is patched by the handler on a bad password.
  "POST /api/auth/login": "auth.login",
  "POST /api/auth/logout": "auth.logout",
};

/**
 * Mutating routes that are deliberately NOT audited, with the reason. Listed so
 * "is this route covered?" has an answer instead of a shrug.
 *
 *  - POST /api/connections/test  : a throwaway ping, writes nothing anywhere.
 *  - POST /api/setup             : creates the first admin when the instance has
 *                                  no users; recorded as `user.create` would need
 *                                  an actor that does not exist yet. The row it
 *                                  creates is visible in Users, and there can
 *                                  only ever be one such call per install.
 *  - POST /api/alerts/:id/test   : sends a test notification, changes no state.
 *  - POST /api/license/refresh   : re-checks the key with the license server; the
 *                                  result (still Pro, or not) is shown in Settings
 *                                  and the key itself was audited when applied.
 *  - POST/PUT/DELETE /api/folders*: folder layout is cosmetic (which queue shows
 *                                  under which label); no queue, job or access
 *                                  changes. Not in the action enum either.
 *  - POST/DELETE /api/flow-edges : same, a drawing on the graph.
 */
const UNAUDITED = new Set([
  "POST /api/connections/test",
  "POST /api/setup",
  "POST /api/alerts/:id/test",
  "POST /api/license/refresh",
]);

export function actionFor(method: string, routePattern: string | undefined): AuditAction | null {
  if (!routePattern) return null;
  return ROUTE_ACTIONS[`${method.toUpperCase()} ${routePattern}`] ?? null;
}

export function isUnaudited(method: string, routePattern: string | undefined): boolean {
  if (!routePattern) return false;
  return UNAUDITED.has(`${method.toUpperCase()} ${routePattern}`);
}

const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** First hop of x-forwarded-for, else the socket address. */
function clientIp(request: FastifyRequest): string | null {
  const fwd = request.headers["x-forwarded-for"];
  const raw = Array.isArray(fwd) ? fwd[0] : fwd;
  if (typeof raw === "string" && raw.trim() !== "") return raw.split(",")[0]?.trim() ?? null;
  return request.ip ?? null;
}

function paramString(params: unknown, key: string): string | null {
  if (typeof params !== "object" || params === null) return null;
  const v = (params as Record<string, unknown>)[key];
  return typeof v === "string" && v !== "" ? v : null;
}

export function registerAuditHook(app: FastifyInstance): void {
  app.decorateRequest("auditPatch", null);
  app.decorateRequest("auditError", null);
  app.decorateRequest("auditDetail", function (this: FastifyRequest, detail: Record<string, unknown>) {
    const current = this.auditPatch ?? {};
    this.auditPatch = { ...current, detail: { ...(current.detail ?? {}), ...detail } };
  });
  app.decorateRequest("auditTarget", function (this: FastifyRequest, target: Omit<AuditPatch, "detail">) {
    this.auditPatch = { ...(this.auditPatch ?? {}), ...target };
  });

  app.addHook("onResponse", async (request: FastifyRequest, reply: FastifyReply) => {
    // Reads are never audited: the UI polls, and a table of GETs hides the
    // twelve rows that matter under a million that do not.
    if (READ_METHODS.has(request.method.toUpperCase())) return;

    const pattern = request.routeOptions?.url;
    if (isUnaudited(request.method, pattern)) return;

    const patch = request.auditPatch ?? {};
    if (patch.skip) return;

    const action = patch.action ?? actionFor(request.method, pattern);
    if (!action) {
      // A mutating route with no mapping is a coverage hole. Loud on purpose:
      // whoever adds the route sees this the first time they call it.
      if (reply.statusCode < 400) {
        request.log.warn(
          { method: request.method, route: pattern ?? request.url },
          "mutating route is not in the audit map (plugins/audit.ts)",
        );
      }
      return;
    }

    const status = reply.statusCode;
    // 4xx/5xx are recorded as failures. A refused obliterate is a finding.
    const result = status >= 400 ? "error" : "ok";

    const connectionId = patch.connectionId ?? paramString(request.params, "id");
    // The connection NAME is resolved from the already-cached rows so the row
    // still reads "prod" after the connection is deleted. Failure to resolve is
    // not an error: the id stays.
    let connectionName = patch.connectionName ?? null;
    if (connectionName === null && connectionId && !connectionId.startsWith("test:")) {
      connectionName = await request.server.ctx.connections
        .getRow(connectionId)
        .then((r) => r.name)
        .catch(() => null);
    }

    await request.server.ctx.audit.record({
      action,
      actor: request.user
        ? { id: request.user.id, email: request.user.email, name: request.user.name, role: request.user.role }
        : null,
      connectionId,
      connectionName,
      queueName: patch.queueName ?? paramString(request.params, "queue") ?? paramString(request.params, "queueName"),
      jobId: patch.jobId ?? paramString(request.params, "jobId"),
      result,
      errorMessage: result === "error" ? (request.auditError ?? `HTTP ${status}`) : null,
      detail: patch.detail ?? null,
      ip: clientIp(request),
      userAgent: typeof request.headers["user-agent"] === "string" ? request.headers["user-agent"] : null,
    });
  });
}
