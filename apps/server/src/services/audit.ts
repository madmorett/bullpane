/**
 * Audit log service (MySQL). Writes are append-only; there is no update and no
 * delete-by-id anywhere in the API — pruning by age is the only removal, and it
 * is a server-side retention job, not a route. An audit trail an admin can edit
 * is not an audit trail.
 *
 * Instrumentation lives in plugins/audit.ts (one global onResponse hook).
 * This file only owns the table.
 */
import {
  type AuditAction,
  type AuditEntry,
  type AuditPage,
  type AuditResult,
  type ListAuditQuery,
  type Role,
} from "@bullmq-visualizer/shared";
import { and, asc, desc, eq, gte, lt, lte, or, sql, type SQL } from "drizzle-orm";
import { nanoid } from "nanoid";
import type { Db } from "../db";
import { auditLog, type AuditLogRow } from "../db/schema";

/** What plugins/audit.ts hands over. Everything but `action` is optional. */
export interface AuditRecordInput {
  action: AuditAction;
  actor?: { id: string; email: string; name: string; role: Role } | null;
  connectionId?: string | null;
  connectionName?: string | null;
  queueName?: string | null;
  jobId?: string | null;
  result?: AuditResult;
  errorMessage?: string | null;
  detail?: Record<string, unknown> | null;
  ip?: string | null;
  userAgent?: string | null;
  /** override the timestamp (tests, replay) */
  createdAt?: Date;
}

export interface AuditLogger {
  info(obj: Record<string, unknown>, msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
}

/** Column widths from the migration. Truncate here so a long UA never 1406s. */
const MAX_ERROR = 500;
const MAX_UA = 255;
const MAX_JOB_ID = 255;

/**
 * Keys that must never reach `detail`, whatever a caller passes. `data` is the
 * job payload and routinely holds customer PII; the rest are credentials. This
 * is belt-and-braces on top of each call site passing only parameters: the
 * privacy rule is enforced in ONE place so a new handler cannot leak by
 * forgetting it. `dataBytes` (a size) is explicitly allowed.
 */
const FORBIDDEN_DETAIL_KEYS = new Set(["data", "payload", "body", "returnvalue", "returnValue", "password", "url", "token", "secret", "key"]);

/**
 * Strip forbidden keys recursively and cap the serialised size. Returns null
 * when nothing is left, so the column stays NULL instead of holding `{}`.
 */
export function sanitizeDetail(detail: Record<string, unknown> | null | undefined): Record<string, unknown> | null {
  if (!detail) return null;
  const clean = walk(detail, 0);
  if (!clean || Object.keys(clean).length === 0) return null;
  // A detail object bigger than this is a bug, not an audit record.
  const json = JSON.stringify(clean);
  if (json.length > 4000) return { truncated: true, bytes: json.length };
  return clean;
}

function walk(value: Record<string, unknown>, depth: number): Record<string, unknown> | null {
  if (depth > 4) return null;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    if (FORBIDDEN_DETAIL_KEYS.has(k)) continue;
    if (v === undefined) continue;
    if (v !== null && typeof v === "object" && !Array.isArray(v)) {
      const nested = walk(v as Record<string, unknown>, depth + 1);
      if (nested && Object.keys(nested).length > 0) out[k] = nested;
      continue;
    }
    out[k] = v;
  }
  return out;
}

export function toAuditEntryDto(row: AuditLogRow): AuditEntry {
  return {
    id: row.id,
    createdAt: row.createdAt.toISOString(),
    actorId: row.actorId ?? null,
    actorEmail: row.actorEmail ?? null,
    actorName: row.actorName ?? null,
    actorRole: row.actorRole ?? null,
    action: row.action,
    connectionId: row.connectionId ?? null,
    connectionName: row.connectionName ?? null,
    queueName: row.queueName ?? null,
    jobId: row.jobId ?? null,
    result: row.result,
    errorMessage: row.errorMessage ?? null,
    detail: row.detail ?? null,
    ip: row.ip ?? null,
    userAgent: row.userAgent ?? null,
  };
}

/** Keyset cursor: `<epoch ms>.<id>`. Opaque to the client. */
export function encodeCursor(row: { createdAt: Date; id: string }): string {
  return `${row.createdAt.getTime()}.${row.id}`;
}

export function decodeCursor(cursor: string): { createdAt: Date; id: string } | null {
  const dot = cursor.indexOf(".");
  if (dot <= 0) return null;
  const ms = Number(cursor.slice(0, dot));
  const id = cursor.slice(dot + 1);
  if (!Number.isFinite(ms) || id === "") return null;
  return { createdAt: new Date(ms), id };
}

function truncate(v: string | null | undefined, max: number): string | null {
  if (v === null || v === undefined) return null;
  return v.length > max ? v.slice(0, max) : v;
}

/** Once a day. The table grows slowly; pruning more often buys nothing. */
const PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000;

export class AuditService {
  private retentionTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly db: Db,
    private readonly log: AuditLogger,
  ) {}

  /**
   * NEVER THROWS. A failing audit insert (MySQL down, column too small, table
   * missing because someone ran an old image) must not turn a working
   * "resume the payments queue" into a 500 for the operator on call. The
   * failure is logged at error level and the request proceeds.
   *
   * The trade-off is explicit: we prefer a gap in the trail over an outage of
   * the tool. If your compliance posture needs the opposite (refuse the action
   * when it cannot be recorded), that is a different product decision and the
   * place to make it is here.
   */
  async record(input: AuditRecordInput): Promise<void> {
    try {
      await this.db.insert(auditLog).values({
        id: nanoid(),
        createdAt: input.createdAt ?? new Date(),
        actorId: input.actor?.id ?? null,
        // Denormalised on purpose: the row must still name the person after the
        // user is deleted. See migrations/0004_audit_log.sql.
        actorEmail: truncate(input.actor?.email ?? null, 255),
        actorName: truncate(input.actor?.name ?? null, 80),
        actorRole: input.actor?.role ?? null,
        action: input.action,
        connectionId: input.connectionId ?? null,
        connectionName: truncate(input.connectionName ?? null, 80),
        queueName: truncate(input.queueName ?? null, 255),
        jobId: truncate(input.jobId ?? null, MAX_JOB_ID),
        result: input.result ?? "ok",
        errorMessage: truncate(input.errorMessage ?? null, MAX_ERROR),
        detail: sanitizeDetail(input.detail),
        ip: truncate(input.ip ?? null, 45),
        userAgent: truncate(input.userAgent ?? null, MAX_UA),
      });
    } catch (err) {
      this.log.error(
        { err: err instanceof Error ? err.message : String(err), action: input.action },
        "audit record failed (action was NOT rolled back)",
      );
    }
  }

  /**
   * Newest first, keyset paged. `cursor` is the last row of the previous page,
   * so page N costs the same as page 1 no matter how big the table gets.
   */
  async list(query: ListAuditQuery): Promise<AuditPage> {
    const filters: SQL[] = [];
    if (query.actorId) filters.push(eq(auditLog.actorId, query.actorId));
    if (query.action) filters.push(eq(auditLog.action, query.action));
    if (query.connectionId) filters.push(eq(auditLog.connectionId, query.connectionId));
    if (query.queueName) filters.push(eq(auditLog.queueName, query.queueName));
    if (query.jobId) filters.push(eq(auditLog.jobId, query.jobId));
    if (query.result) filters.push(eq(auditLog.result, query.result));
    if (query.from) filters.push(gte(auditLog.createdAt, new Date(query.from)));
    if (query.to) filters.push(lt(auditLog.createdAt, new Date(query.to)));

    if (query.cursor) {
      const c = decodeCursor(query.cursor);
      if (c) {
        // (created_at, id) < (cursor.created_at, cursor.id), descending.
        const keyset = or(lt(auditLog.createdAt, c.createdAt), and(eq(auditLog.createdAt, c.createdAt), lt(auditLog.id, c.id)));
        if (keyset) filters.push(keyset);
      }
    }

    const where = filters.length === 0 ? undefined : filters.length === 1 ? filters[0] : and(...filters);
    // One extra row tells us whether another page exists without a COUNT(*).
    const rows = await this.db
      .select()
      .from(auditLog)
      .where(where)
      .orderBy(desc(auditLog.createdAt), desc(auditLog.id))
      .limit(query.limit + 1);

    const page = rows.slice(0, query.limit);
    const last = page[page.length - 1];
    return {
      entries: page.map(toAuditEntryDto),
      nextCursor: rows.length > query.limit && last ? encodeCursor(last) : null,
    };
  }

  /**
   * Distinct actors present in the log, for the "who" filter. Read from the log
   * itself rather than from `users`, so people who have since been deleted can
   * still be filtered on — the whole point of denormalising the actor.
   */
  async listActors(): Promise<Array<{ id: string | null; name: string | null; email: string | null }>> {
    const rows = await this.db
      .selectDistinct({ id: auditLog.actorId, name: auditLog.actorName, email: auditLog.actorEmail })
      .from(auditLog)
      .orderBy(asc(auditLog.actorName))
      .limit(200);
    return rows.map((r) => ({ id: r.id ?? null, name: r.name ?? null, email: r.email ?? null }));
  }

  /**
   * Retention. Same shape as `AlertsService.pruneEvents(olderThan)`; like it,
   * it deletes by age and nothing else. This is the ONLY removal path in the
   * whole feature — there is no delete route, on purpose.
   */
  async prune(olderThan: Date): Promise<void> {
    await this.db.delete(auditLog).where(lte(auditLog.createdAt, olderThan));
  }

  /**
   * Periodic retention, modelled on AlertsEngine's timer (interval, unref'd,
   * one immediate run). It is deliberately NOT folded into the alerts tick:
   * that tick returns early unless the edition has alerts unlocked, so rows
   * written while a license was active would grow forever after it lapsed.
   *
   * Once a day is plenty for a table that grows by hundreds of rows a day.
   * `retentionDays: 0` means keep forever and starts no timer.
   */
  startRetention(retentionDays: number): void {
    if (this.retentionTimer || retentionDays <= 0) return;
    const run = async (): Promise<void> => {
      try {
        await this.prune(new Date(Date.now() - retentionDays * 86_400_000));
      } catch (err) {
        this.log.error({ err: err instanceof Error ? err.message : String(err) }, "audit prune failed");
      }
    };
    this.retentionTimer = setInterval(() => void run(), PRUNE_INTERVAL_MS);
    this.retentionTimer.unref();
    this.log.info({ retentionDays }, "audit retention started");
    void run();
  }

  stopRetention(): void {
    if (this.retentionTimer) clearInterval(this.retentionTimer);
    this.retentionTimer = null;
  }

  /** Rough row count, for the "the table grows" note on the page. */
  async count(): Promise<number> {
    try {
      const rows = await this.db.select({ n: sql<number>`count(*)` }).from(auditLog);
      return Number(rows[0]?.n ?? 0);
    } catch {
      return 0;
    }
  }
}
