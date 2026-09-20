/**
 * DB-backed sessions. The cookie holds a random 32-byte id (signed by
 * @fastify/cookie); the row holds who it belongs to and when it expires.
 */
import { randomBytes } from "node:crypto";
import type { User } from "@bullpane/shared";
import { and, eq, gt, isNull, lt } from "drizzle-orm";
import type { CookieSerializeOptions } from "@fastify/cookie";
import type { Config } from "../config";
import { isHttps } from "../config";
import type { Db } from "../db";
import { sessions, users, type UserRow } from "../db/schema";

export const SESSION_COOKIE = "bullpane_session";
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export function toUserDto(row: UserRow): User {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    role: row.role,
    createdAt: row.createdAt.toISOString(),
    lastLoginAt: row.lastLoginAt ? row.lastLoginAt.toISOString() : null,
    disabledAt: row.disabledAt ? row.disabledAt.toISOString() : null,
  };
}

export function sessionCookieOptions(config: Pick<Config, "publicUrl">, expiresAt?: Date): CookieSerializeOptions {
  return {
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    secure: isHttps(config.publicUrl),
    signed: true,
    ...(expiresAt ? { expires: expiresAt } : {}),
  };
}

export class SessionService {
  constructor(private readonly db: Db) {}

  /**
   * `authMethod` records HOW this session was authenticated. Same cookie, same
   * TTL, same table as a password login — deliberately one session path, so SSO
   * cannot drift into a second, less-reviewed way of being logged in.
   */
  async create(userId: string, now = new Date(), authMethod: "password" | "sso" = "password"): Promise<{ id: string; expiresAt: Date }> {
    const id = randomBytes(32).toString("base64url");
    const expiresAt = new Date(now.getTime() + SESSION_TTL_MS);
    await this.db.insert(sessions).values({ id, userId, expiresAt, createdAt: now, authMethod });
    return { id, expiresAt };
  }

  /**
   * Returns the user of a live session, or null. Disabling a user deletes their
   * sessions, but the check here is what makes the revoke hold even if a session
   * row were to survive (a race with a login in flight, a restore from backup).
   */
  async resolve(sessionId: string, now = new Date()): Promise<User | null> {
    const rows = await this.db
      .select({ user: users })
      .from(sessions)
      .innerJoin(users, eq(sessions.userId, users.id))
      .where(and(eq(sessions.id, sessionId), gt(sessions.expiresAt, now), isNull(users.disabledAt)))
      .limit(1);
    const row = rows[0];
    return row ? toUserDto(row.user) : null;
  }

  async destroy(sessionId: string): Promise<void> {
    await this.db.delete(sessions).where(eq(sessions.id, sessionId));
  }

  async destroyForUser(userId: string): Promise<void> {
    await this.db.delete(sessions).where(eq(sessions.userId, userId));
  }

  async purgeExpired(now = new Date()): Promise<void> {
    await this.db.delete(sessions).where(lt(sessions.expiresAt, now));
  }
}
