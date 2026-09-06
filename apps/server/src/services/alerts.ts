/**
 * Alert CRUD + events (MySQL). Evaluation lives in ../alerts/engine.ts.
 */
import type { Alert, AlertEvent, AlertScope, CreateAlertInput, updateAlertSchema } from "@bullmq-visualizer/shared";
import { and, desc, eq, lt } from "drizzle-orm";
import { nanoid } from "nanoid";
import type { z } from "zod";
import type { Db } from "../db";
import { alertEvents, type AlertEventRow, type AlertRow, alerts } from "../db/schema";
import { notFound } from "../plugins/errors";
import type { ConnectionsService } from "./connections";
import type { FoldersService } from "./folders";

export type UpdateAlertInput = z.infer<typeof updateAlertSchema>;

export function scopeOf(row: Pick<AlertRow, "scopeType" | "connectionId" | "queueName" | "folderId">): AlertScope {
  if (row.scopeType === "folder") return { type: "folder", folderId: row.folderId ?? "" };
  return { type: "queue", connectionId: row.connectionId ?? "", queueName: row.queueName ?? "" };
}

function scopeColumns(scope: AlertScope): Pick<typeof alerts.$inferInsert, "scopeType" | "connectionId" | "queueName" | "folderId"> {
  return scope.type === "folder"
    ? { scopeType: "folder", connectionId: null, queueName: null, folderId: scope.folderId }
    : { scopeType: "queue", connectionId: scope.connectionId, queueName: scope.queueName, folderId: null };
}

export function toAlertDto(row: AlertRow): Alert {
  return {
    id: row.id,
    name: row.name,
    enabled: row.enabled,
    scope: scopeOf(row),
    condition: row.condition,
    channels: row.channels,
    cooldownMinutes: row.cooldownMinutes,
    createdAt: row.createdAt.toISOString(),
    lastFiredAt: row.lastFiredAt ? row.lastFiredAt.toISOString() : null,
    firing: row.firing,
  };
}

export function toAlertEventDto(row: AlertEventRow): AlertEvent {
  return {
    id: row.id,
    alertId: row.alertId,
    alertName: row.alertName,
    connectionId: row.connectionId,
    queueName: row.queueName ?? null,
    kind: row.kind,
    status: row.status,
    message: row.message,
    value: row.value ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

export class AlertsService {
  constructor(
    private readonly db: Db,
    private readonly connections: ConnectionsService,
    private readonly folders: FoldersService,
  ) {}

  /** Throws 404 when the scope points at a missing connection or folder. */
  private async assertScope(scope: AlertScope): Promise<void> {
    if (scope.type === "folder") await this.folders.get(scope.folderId);
    else await this.connections.getRow(scope.connectionId);
  }

  async listRows(opts: { enabledOnly?: boolean } = {}): Promise<AlertRow[]> {
    const q = this.db.select().from(alerts);
    const rows = opts.enabledOnly ? await q.where(eq(alerts.enabled, true)) : await q;
    return rows.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  }

  async list(): Promise<Alert[]> {
    return (await this.listRows()).map(toAlertDto);
  }

  async getRow(id: string): Promise<AlertRow> {
    const rows = await this.db.select().from(alerts).where(eq(alerts.id, id)).limit(1);
    const row = rows[0];
    if (!row) throw notFound("Alert");
    return row;
  }

  async count(): Promise<number> {
    return (await this.db.select({ id: alerts.id }).from(alerts)).length;
  }

  async create(input: CreateAlertInput): Promise<Alert> {
    await this.assertScope(input.scope);
    const id = nanoid();
    await this.db.insert(alerts).values({
      id,
      name: input.name,
      enabled: input.enabled,
      ...scopeColumns(input.scope),
      condition: input.condition,
      channels: input.channels,
      cooldownMinutes: input.cooldownMinutes,
      createdAt: new Date(),
      lastFiredAt: null,
      firing: false,
    });
    return toAlertDto(await this.getRow(id));
  }

  async update(id: string, input: UpdateAlertInput): Promise<Alert> {
    const current = await this.getRow(id);
    const patch: Partial<typeof alerts.$inferInsert> = {};
    if (input.name !== undefined) patch.name = input.name;
    if (input.enabled !== undefined) patch.enabled = input.enabled;
    if (input.scope !== undefined) {
      await this.assertScope(input.scope);
      Object.assign(patch, scopeColumns(input.scope));
      // A new target restarts evaluation from a clean state.
      if (JSON.stringify(input.scope) !== JSON.stringify(scopeOf(current))) patch.firing = false;
    }
    if (input.condition !== undefined) {
      patch.condition = input.condition;
      // A changed condition restarts evaluation from a clean state.
      if (JSON.stringify(input.condition) !== JSON.stringify(current.condition)) patch.firing = false;
    }
    if (input.channels !== undefined) patch.channels = input.channels;
    if (input.cooldownMinutes !== undefined) patch.cooldownMinutes = input.cooldownMinutes;
    if (input.enabled === false) patch.firing = false;
    if (Object.keys(patch).length > 0) {
      await this.db.update(alerts).set(patch).where(eq(alerts.id, id));
    }
    return toAlertDto(await this.getRow(id));
  }

  async remove(id: string): Promise<void> {
    await this.getRow(id);
    await this.db.delete(alerts).where(eq(alerts.id, id));
  }

  async setState(id: string, state: { firing: boolean; lastFiredAt: Date | null }): Promise<void> {
    await this.db.update(alerts).set(state).where(eq(alerts.id, id));
  }

  async recordEvent(input: Omit<AlertEventRow, "id" | "createdAt">): Promise<void> {
    await this.db.insert(alertEvents).values({ ...input, id: nanoid(), createdAt: new Date() });
  }

  async listEvents(opts: { limit: number; alertId?: string }): Promise<AlertEvent[]> {
    const where = opts.alertId ? and(eq(alertEvents.alertId, opts.alertId)) : undefined;
    const rows = await this.db
      .select()
      .from(alertEvents)
      .where(where)
      .orderBy(desc(alertEvents.createdAt))
      .limit(opts.limit);
    return rows.map(toAlertEventDto);
  }

  async pruneEvents(olderThan: Date): Promise<void> {
    await this.db.delete(alertEvents).where(lt(alertEvents.createdAt, olderThan));
  }
}
