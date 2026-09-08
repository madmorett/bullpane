import type { CreateUserInput, Role, UpdateUserInput, User } from "@bullpane/shared";
import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { hashPassword } from "../auth/password";
import { toUserDto } from "../auth/sessions";
import type { Db } from "../db";
import { type UserRow, users } from "../db/schema";
import { conflict, notFound } from "../plugins/errors";

export class UsersService {
  constructor(private readonly db: Db) {}

  async count(): Promise<number> {
    return (await this.db.select({ id: users.id }).from(users)).length;
  }

  async list(): Promise<User[]> {
    const rows = await this.db.select().from(users).orderBy(users.createdAt);
    return rows.map(toUserDto);
  }

  async getRow(id: string): Promise<UserRow> {
    const rows = await this.db.select().from(users).where(eq(users.id, id)).limit(1);
    const row = rows[0];
    if (!row) throw notFound("User");
    return row;
  }

  async findByEmail(email: string): Promise<UserRow | null> {
    const rows = await this.db.select().from(users).where(eq(users.email, email.toLowerCase())).limit(1);
    return rows[0] ?? null;
  }

  async create(input: CreateUserInput): Promise<User> {
    const email = input.email.toLowerCase();
    if (await this.findByEmail(email)) throw conflict("A user with this email already exists");
    const id = nanoid();
    await this.db.insert(users).values({
      id,
      email,
      name: input.name,
      role: input.role,
      // NULL when the admin creates an SSO-only account (no password given).
      passwordHash: input.password === undefined ? null : await hashPassword(input.password),
      createdAt: new Date(),
      lastLoginAt: null,
    });
    return toUserDto(await this.getRow(id));
  }

  async update(id: string, input: UpdateUserInput, actor: User): Promise<User> {
    const row = await this.getRow(id);
    const patch: Partial<typeof users.$inferInsert> = {};
    if (input.name !== undefined) patch.name = input.name;
    if (input.role !== undefined && input.role !== row.role) {
      if (row.role === "admin" && (await this.adminCount()) <= 1) throw conflict("Cannot demote the last admin");
      if (row.id === actor.id && input.role !== "admin") throw conflict("You cannot demote yourself");
      patch.role = input.role as Role;
    }
    if (input.password !== undefined) patch.passwordHash = await hashPassword(input.password);
    if (Object.keys(patch).length > 0) {
      await this.db.update(users).set(patch).where(eq(users.id, id));
    }
    return toUserDto(await this.getRow(id));
  }

  async remove(id: string, actor: User): Promise<void> {
    const row = await this.getRow(id);
    if (row.id === actor.id) throw conflict("You cannot delete your own account");
    if (row.role === "admin" && (await this.adminCount()) <= 1) throw conflict("Cannot delete the last admin");
    await this.db.delete(users).where(eq(users.id, id));
  }

  async touchLogin(id: string, at = new Date()): Promise<void> {
    await this.db.update(users).set({ lastLoginAt: at }).where(eq(users.id, id));
  }

  private async adminCount(): Promise<number> {
    return (await this.db.select({ id: users.id }).from(users).where(eq(users.role, "admin"))).length;
  }
}
