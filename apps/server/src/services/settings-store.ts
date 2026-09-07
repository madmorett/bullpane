/**
 * Key/value access to the `settings` table, behind an interface so services
 * that only need a few flags (the edition) can be unit tested without drizzle.
 */
import { eq } from "drizzle-orm";
import type { Db } from "../db";
import { settings } from "../db/schema";

export interface SettingsStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

export class DrizzleSettingsStore implements SettingsStore {
  constructor(private readonly db: Db) {}

  async get(key: string): Promise<string | null> {
    const rows = await this.db.select().from(settings).where(eq(settings.key, key)).limit(1);
    const value = rows[0]?.value;
    return value === undefined || value === "" ? null : value;
  }

  async set(key: string, value: string): Promise<void> {
    await this.db.insert(settings).values({ key, value }).onDuplicateKeyUpdate({ set: { value } });
  }

  async delete(key: string): Promise<void> {
    await this.db.delete(settings).where(eq(settings.key, key));
  }
}

/** In-memory store for tests. */
export class MemorySettingsStore implements SettingsStore {
  readonly map = new Map<string, string>();
  async get(key: string): Promise<string | null> {
    return this.map.get(key) ?? null;
  }
  async set(key: string, value: string): Promise<void> {
    this.map.set(key, value);
  }
  async delete(key: string): Promise<void> {
    this.map.delete(key);
  }
}
