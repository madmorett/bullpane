/**
 * Persistence for the MCP OAuth server, behind an interface so the whole flow
 * (register → authorize → token → /mcp) can be tested through `app.inject`
 * without MySQL. Schema and rationale: migrations/0009_mcp.sql.
 *
 * The two single-use operations — consuming a code and rotating a refresh token —
 * are conditional writes whose affected-row count decides who won. Two replicas
 * racing on the same code cannot both get a token.
 */
import { and, desc, eq, lt, notInArray } from "drizzle-orm";
import type { Db } from "../../db";
import {
  mcpAuthCodes,
  mcpClients,
  mcpGrants,
  users,
  type McpAuthCodeRow,
  type McpClientRow,
  type McpGrantRow,
  type UserRow,
} from "../../db/schema";

export interface McpGrantWithUser {
  grant: McpGrantRow;
  user: UserRow;
  clientName: string;
  redirectUris: string[];
}

export interface McpStore {
  insertClient(row: McpClientRow): Promise<void>;
  getClient(id: string): Promise<McpClientRow | null>;
  countClients(): Promise<number>;
  /** clients registered before `before` that never got a grant (abandoned registrations) */
  purgeUnusedClients(before: Date): Promise<void>;

  insertCode(row: McpAuthCodeRow): Promise<void>;
  /** deletes and returns the code; null when it does not exist or another caller took it */
  consumeCode(codeHash: string): Promise<McpAuthCodeRow | null>;
  purgeExpiredCodes(now: Date): Promise<void>;

  insertGrant(row: McpGrantRow): Promise<void>;
  findGrantByRefresh(refreshHash: string): Promise<McpGrantRow | null>;
  findGrantByPrevRefresh(refreshHash: string): Promise<McpGrantRow | null>;
  /** swaps the refresh token only if it is still `oldHash`; false when someone else rotated first */
  rotateRefresh(grantId: string, oldHash: string, newHash: string, expiresAt: Date): Promise<boolean>;
  getGrantWithUser(grantId: string): Promise<McpGrantWithUser | null>;
  touchGrant(grantId: string, at: Date): Promise<void>;
  deleteGrant(grantId: string): Promise<void>;
  deleteGrantsForUser(userId: string): Promise<void>;
  /** userId null = every user's grants (admin view) */
  listGrants(userId: string | null): Promise<McpGrantWithUser[]>;
}

function affectedRows(result: unknown): number {
  // drizzle's mysql2 driver resolves writes to [ResultSetHeader, fields]
  const header = Array.isArray(result) ? result[0] : result;
  return typeof header === "object" && header !== null && "affectedRows" in header ? Number(header.affectedRows) : 0;
}

export class DrizzleMcpStore implements McpStore {
  constructor(private readonly db: Db) {}

  async insertClient(row: McpClientRow): Promise<void> {
    await this.db.insert(mcpClients).values(row);
  }

  async getClient(id: string): Promise<McpClientRow | null> {
    const rows = await this.db.select().from(mcpClients).where(eq(mcpClients.id, id)).limit(1);
    return rows[0] ?? null;
  }

  async countClients(): Promise<number> {
    return (await this.db.select({ id: mcpClients.id }).from(mcpClients)).length;
  }

  async purgeUnusedClients(before: Date): Promise<void> {
    const used = this.db.selectDistinct({ id: mcpGrants.clientId }).from(mcpGrants);
    await this.db.delete(mcpClients).where(and(lt(mcpClients.createdAt, before), notInArray(mcpClients.id, used)));
  }

  async insertCode(row: McpAuthCodeRow): Promise<void> {
    await this.db.insert(mcpAuthCodes).values(row);
  }

  async consumeCode(codeHash: string): Promise<McpAuthCodeRow | null> {
    const rows = await this.db.select().from(mcpAuthCodes).where(eq(mcpAuthCodes.codeHash, codeHash)).limit(1);
    const row = rows[0];
    if (!row) return null;
    const res = await this.db.delete(mcpAuthCodes).where(eq(mcpAuthCodes.codeHash, codeHash));
    return affectedRows(res) === 1 ? row : null;
  }

  async purgeExpiredCodes(now: Date): Promise<void> {
    await this.db.delete(mcpAuthCodes).where(lt(mcpAuthCodes.expiresAt, now));
  }

  async insertGrant(row: McpGrantRow): Promise<void> {
    await this.db.insert(mcpGrants).values(row);
  }

  async findGrantByRefresh(refreshHash: string): Promise<McpGrantRow | null> {
    const rows = await this.db.select().from(mcpGrants).where(eq(mcpGrants.refreshHash, refreshHash)).limit(1);
    return rows[0] ?? null;
  }

  async findGrantByPrevRefresh(refreshHash: string): Promise<McpGrantRow | null> {
    const rows = await this.db.select().from(mcpGrants).where(eq(mcpGrants.prevRefreshHash, refreshHash)).limit(1);
    return rows[0] ?? null;
  }

  async rotateRefresh(grantId: string, oldHash: string, newHash: string, expiresAt: Date): Promise<boolean> {
    const res = await this.db
      .update(mcpGrants)
      .set({ refreshHash: newHash, prevRefreshHash: oldHash, refreshExpiresAt: expiresAt })
      .where(and(eq(mcpGrants.id, grantId), eq(mcpGrants.refreshHash, oldHash)));
    return affectedRows(res) === 1;
  }

  async getGrantWithUser(grantId: string): Promise<McpGrantWithUser | null> {
    const rows = await this.db
      .select({ grant: mcpGrants, user: users, clientName: mcpClients.name, redirectUris: mcpClients.redirectUris })
      .from(mcpGrants)
      .innerJoin(users, eq(mcpGrants.userId, users.id))
      .innerJoin(mcpClients, eq(mcpGrants.clientId, mcpClients.id))
      .where(eq(mcpGrants.id, grantId))
      .limit(1);
    return rows[0] ?? null;
  }

  async touchGrant(grantId: string, at: Date): Promise<void> {
    await this.db.update(mcpGrants).set({ lastUsedAt: at }).where(eq(mcpGrants.id, grantId));
  }

  async deleteGrant(grantId: string): Promise<void> {
    await this.db.delete(mcpGrants).where(eq(mcpGrants.id, grantId));
  }

  async deleteGrantsForUser(userId: string): Promise<void> {
    await this.db.delete(mcpGrants).where(eq(mcpGrants.userId, userId));
  }

  async listGrants(userId: string | null): Promise<McpGrantWithUser[]> {
    const q = this.db
      .select({ grant: mcpGrants, user: users, clientName: mcpClients.name, redirectUris: mcpClients.redirectUris })
      .from(mcpGrants)
      .innerJoin(users, eq(mcpGrants.userId, users.id))
      .innerJoin(mcpClients, eq(mcpGrants.clientId, mcpClients.id));
    const rows = await (userId ? q.where(eq(mcpGrants.userId, userId)) : q).orderBy(desc(mcpGrants.createdAt)).limit(500);
    return rows;
  }
}

/** In-memory store for tests. Same single-use semantics as the MySQL one. */
export class MemoryMcpStore implements McpStore {
  readonly clients = new Map<string, McpClientRow>();
  readonly codes = new Map<string, McpAuthCodeRow>();
  readonly grants = new Map<string, McpGrantRow>();

  constructor(private readonly usersById: (id: string) => UserRow | null) {}

  async insertClient(row: McpClientRow): Promise<void> {
    this.clients.set(row.id, row);
  }
  async getClient(id: string): Promise<McpClientRow | null> {
    return this.clients.get(id) ?? null;
  }
  async countClients(): Promise<number> {
    return this.clients.size;
  }
  async purgeUnusedClients(before: Date): Promise<void> {
    const used = new Set([...this.grants.values()].map((g) => g.clientId));
    for (const c of this.clients.values()) if (c.createdAt < before && !used.has(c.id)) this.clients.delete(c.id);
  }
  async insertCode(row: McpAuthCodeRow): Promise<void> {
    this.codes.set(row.codeHash, row);
  }
  async consumeCode(codeHash: string): Promise<McpAuthCodeRow | null> {
    const row = this.codes.get(codeHash) ?? null;
    this.codes.delete(codeHash);
    return row;
  }
  async purgeExpiredCodes(now: Date): Promise<void> {
    for (const [k, c] of this.codes) if (c.expiresAt < now) this.codes.delete(k);
  }
  async insertGrant(row: McpGrantRow): Promise<void> {
    this.grants.set(row.id, row);
  }
  async findGrantByRefresh(refreshHash: string): Promise<McpGrantRow | null> {
    return [...this.grants.values()].find((g) => g.refreshHash === refreshHash) ?? null;
  }
  async findGrantByPrevRefresh(refreshHash: string): Promise<McpGrantRow | null> {
    return [...this.grants.values()].find((g) => g.prevRefreshHash === refreshHash) ?? null;
  }
  async rotateRefresh(grantId: string, oldHash: string, newHash: string, expiresAt: Date): Promise<boolean> {
    const g = this.grants.get(grantId);
    if (!g || g.refreshHash !== oldHash) return false;
    this.grants.set(grantId, { ...g, refreshHash: newHash, prevRefreshHash: oldHash, refreshExpiresAt: expiresAt });
    return true;
  }
  async getGrantWithUser(grantId: string): Promise<McpGrantWithUser | null> {
    const grant = this.grants.get(grantId);
    if (!grant) return null;
    const user = this.usersById(grant.userId);
    const client = this.clients.get(grant.clientId);
    if (!user || !client) return null;
    return { grant, user, clientName: client.name, redirectUris: client.redirectUris };
  }
  async touchGrant(grantId: string, at: Date): Promise<void> {
    const g = this.grants.get(grantId);
    if (g) this.grants.set(grantId, { ...g, lastUsedAt: at });
  }
  async deleteGrant(grantId: string): Promise<void> {
    this.grants.delete(grantId);
  }
  async deleteGrantsForUser(userId: string): Promise<void> {
    for (const [id, g] of this.grants) if (g.userId === userId) this.grants.delete(id);
  }
  async listGrants(userId: string | null): Promise<McpGrantWithUser[]> {
    const out: McpGrantWithUser[] = [];
    for (const g of this.grants.values()) {
      if (userId && g.userId !== userId) continue;
      const full = await this.getGrantWithUser(g.id);
      if (full) out.push(full);
    }
    return out.sort((a, b) => b.grant.createdAt.getTime() - a.grant.createdAt.getTime());
  }
}
