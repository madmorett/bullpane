/**
 * Audit log routes. READ ONLY, on purpose.
 *
 * There is no POST, no PATCH and no DELETE here. A log an admin can edit or
 * clear from the UI answers "what happened?" with "whatever the last admin
 * wanted you to believe", which is worth less than no log at all. Rows leave
 * only by age, through the retention job (BMV_AUDIT_RETENTION_DAYS).
 *
 * Role is **admin**, not viewer or operator: the log shows what everyone did,
 * including admin-only actions (connections, users, license). An operator who
 * could read it would learn about access changes that are none of their
 * business. Reading who paused a queue is not the same right as pausing it.
 */
import { type AuditEntry, type AuditPage, listAuditQuerySchema } from "@bullmq-visualizer/shared";
import type { FastifyInstance } from "fastify";
import { requireAuth, requireRole } from "../auth/guards";
import { requireFeature } from "../plugins/gates";

/** Hard cap on an export. See the comment on the route. */
const EXPORT_MAX_ROWS = 50_000;
const EXPORT_PAGE = 500;

export async function auditRoutes(app: FastifyInstance): Promise<void> {
  const gate = requireFeature("audit");
  const admin = [requireAuth, gate, requireRole("admin")];

  app.get("/audit", { preHandler: admin }, async (request): Promise<AuditPage> => {
    const query = listAuditQuerySchema.parse(request.query);
    return app.ctx.audit.list(query);
  });

  /**
   * Distinct actors seen in the log, for the "who" filter. Read from the log,
   * not from `users`, so a person who has since been deleted is still
   * filterable — which is the entire reason the actor is denormalised.
   * Registered before /audit/export so neither shadows the other (both are
   * static segments, so Fastify's router is unambiguous anyway).
   */
  app.get("/audit/actors", { preHandler: admin }, async () => app.ctx.audit.listActors());

  /**
   * CSV export for compliance. Same filters as the list.
   *
   * Size: paged internally in chunks of EXPORT_PAGE with the same keyset cursor
   * and streamed row by row, so memory is one page, not the table. It stops at
   * EXPORT_MAX_ROWS and says so in a trailing comment line rather than
   * silently truncating — an export that quietly lost the second half of the
   * year is worse than one that tells you to narrow the date range.
   */
  app.get("/audit/export", { preHandler: admin }, async (request, reply) => {
    const query = listAuditQuerySchema.parse(request.query);
    const stamp = new Date().toISOString().slice(0, 10);
    reply.header("content-type", "text/csv; charset=utf-8");
    reply.header("content-disposition", `attachment; filename="audit-log-${stamp}.csv"`);

    const chunks: string[] = [
      "timestamp,actor_name,actor_email,actor_role,action,result,connection,queue,job_id,error,ip,detail\n",
    ];
    let cursor: string | undefined = query.cursor;
    let written = 0;
    let hitCap = false;

    for (;;) {
      const page: AuditPage = await app.ctx.audit.list({
        ...query,
        limit: Math.min(EXPORT_PAGE, EXPORT_MAX_ROWS - written),
        ...(cursor ? { cursor } : {}),
      });
      for (const entry of page.entries) chunks.push(csvRow(entry));
      written += page.entries.length;
      if (!page.nextCursor) break;
      if (written >= EXPORT_MAX_ROWS) {
        hitCap = true;
        break;
      }
      cursor = page.nextCursor;
    }
    if (hitCap) {
      chunks.push(`# truncated at ${EXPORT_MAX_ROWS} rows — narrow the date range and export again\n`);
    }
    return chunks.join("");
  });
}

/** RFC 4180 quoting. A queue name with a comma must not shift every column. */
function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  const s = typeof value === "string" ? value : JSON.stringify(value);
  // A leading =, +, - or @ makes Excel evaluate the cell as a formula. Prefix
  // with a quote so a user agent string cannot become a spreadsheet exploit.
  const safe = /^[=+\-@]/.test(s) ? `'${s}` : s;
  return `"${safe.replace(/"/g, '""')}"`;
}

function csvRow(e: AuditEntry): string {
  return (
    [
      e.createdAt,
      e.actorName,
      e.actorEmail,
      e.actorRole,
      e.action,
      e.result,
      e.connectionName ?? e.connectionId,
      e.queueName,
      e.jobId,
      e.errorMessage,
      e.ip,
      // `detail` is action parameters only; the sanitiser in services/audit.ts
      // guarantees no job payload ever reached the column.
      e.detail ? JSON.stringify(e.detail) : null,
    ]
      .map(csvCell)
      .join(",") + "\n"
  );
}
