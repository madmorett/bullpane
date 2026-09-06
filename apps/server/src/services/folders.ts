import type { Folder, FolderQueueRef } from "@bullmq-visualizer/shared";
import { eq, inArray } from "drizzle-orm";
import { nanoid } from "nanoid";
import type { Db } from "../db";
import { folderQueues, type FolderRow, folders } from "../db/schema";
import { conflict, notFound } from "../plugins/errors";

export interface CreateFolderInput {
  name: string;
  color?: string | null;
  parentId?: string | null;
}
export interface UpdateFolderInput extends Partial<CreateFolderInput> {
  position?: number;
}

export class FoldersService {
  constructor(private readonly db: Db) {}

  async count(): Promise<number> {
    return (await this.db.select({ id: folders.id }).from(folders)).length;
  }

  async list(): Promise<Folder[]> {
    const rows = await this.db.select().from(folders).orderBy(folders.position, folders.name);
    if (rows.length === 0) return [];
    const refs = await this.db
      .select()
      .from(folderQueues)
      .where(
        inArray(
          folderQueues.folderId,
          rows.map((r) => r.id),
        ),
      );
    const byFolder = new Map<string, FolderQueueRef[]>();
    for (const ref of refs) {
      const list = byFolder.get(ref.folderId) ?? [];
      list.push({ connectionId: ref.connectionId, queueName: ref.queueName });
      byFolder.set(ref.folderId, list);
    }
    return rows.map((row) => toFolderDto(row, byFolder.get(row.id) ?? []));
  }

  async get(id: string): Promise<Folder> {
    const rows = await this.db.select().from(folders).where(eq(folders.id, id)).limit(1);
    const row = rows[0];
    if (!row) throw notFound("Folder");
    const refs = await this.db.select().from(folderQueues).where(eq(folderQueues.folderId, id));
    return toFolderDto(
      row,
      refs.map((r) => ({ connectionId: r.connectionId, queueName: r.queueName })),
    );
  }

  async create(input: CreateFolderInput): Promise<Folder> {
    if (input.parentId) await this.get(input.parentId);
    const id = nanoid();
    const siblings = await this.db.select({ id: folders.id }).from(folders);
    await this.db.insert(folders).values({
      id,
      name: input.name,
      color: input.color ?? null,
      parentId: input.parentId ?? null,
      position: siblings.length,
    });
    return this.get(id);
  }

  async update(id: string, input: UpdateFolderInput): Promise<Folder> {
    await this.get(id);
    if (input.parentId) {
      if (input.parentId === id) throw conflict("A folder cannot be its own parent");
      await this.get(input.parentId);
    }
    const patch: Partial<typeof folders.$inferInsert> = {};
    if (input.name !== undefined) patch.name = input.name;
    if (input.color !== undefined) patch.color = input.color;
    if (input.parentId !== undefined) patch.parentId = input.parentId;
    if (input.position !== undefined) patch.position = input.position;
    if (Object.keys(patch).length > 0) {
      await this.db.update(folders).set(patch).where(eq(folders.id, id));
    }
    return this.get(id);
  }

  async remove(id: string): Promise<void> {
    await this.get(id);
    // Children move up one level rather than disappearing.
    await this.db.update(folders).set({ parentId: null }).where(eq(folders.parentId, id));
    await this.db.delete(folderQueues).where(eq(folderQueues.folderId, id));
    await this.db.delete(folders).where(eq(folders.id, id));
  }

  async setQueues(id: string, queues: FolderQueueRef[]): Promise<Folder> {
    await this.get(id);
    const unique = new Map<string, FolderQueueRef>();
    for (const q of queues) unique.set(`${q.connectionId}|${q.queueName}`, q);
    await this.db.delete(folderQueues).where(eq(folderQueues.folderId, id));
    if (unique.size > 0) {
      await this.db
        .insert(folderQueues)
        .values([...unique.values()].map((q) => ({ folderId: id, connectionId: q.connectionId, queueName: q.queueName })));
    }
    return this.get(id);
  }
}

export function toFolderDto(row: FolderRow, queues: FolderQueueRef[]): Folder {
  return {
    id: row.id,
    name: row.name,
    color: row.color ?? null,
    parentId: row.parentId ?? null,
    position: row.position,
    queues,
  };
}
