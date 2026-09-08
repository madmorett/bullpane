/**
 * Deleting a folder must not take its subfolders down with it.
 *
 * What is pinned down here:
 *  - the folder itself and its queue assignments are gone;
 *  - its subfolders survive, promoted to the top level (parentId null), which
 *    is what the delete confirmation in FoldersPage.tsx promises the user;
 *  - the subfolders keep their own queue assignments;
 *  - a folder that does not exist is a 404, not a silent no-op.
 *
 * The UI copy and this behaviour drifted apart once already (the dialog used to
 * say "Subfolders are deleted too"), so the promotion is asserted explicitly.
 *
 * No MySQL here: `db` is a stub that records the rows it was given, in the
 * style of hiddenQueues.test.ts / readonly.test.ts.
 */
import { beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../db";
import { FoldersService } from "../services/folders";
import { HttpError } from "../plugins/errors";

interface FolderRowState {
  id: string;
  name: string;
  color: string | null;
  parentId: string | null;
  position: number;
}
interface FolderQueueState {
  folderId: string;
  connectionId: string;
  queueName: string;
}

/**
 * Minimal drizzle-shaped stub covering the shapes FoldersService builds:
 * select-folders, select-folder-queues, update-folders, delete-folder-queues,
 * delete-folders. Which table a query targets is decided by table identity, so
 * no SQL is parsed; `where` conditions are opaque, so the test drives the
 * filter explicitly via __setFilter, as hiddenQueues.test.ts does.
 */
function fakeDb(folderRows: FolderRowState[], queueRows: FolderQueueState[]) {
  const state = { folders: folderRows, folderQueues: queueRows };
  let pendingFilter: { id?: string; parentId?: string; folderId?: string } = {};

  const db = {
    __state: state,
    __setFilter(f: typeof pendingFilter) {
      pendingFilter = f;
    },
    select(_fields?: unknown) {
      return {
        from(table: unknown) {
          const name = tableName(table);
          const builder = {
            where(_cond: unknown) {
              return builder;
            },
            limit(_n: number) {
              return builder;
            },
            orderBy(..._o: unknown[]) {
              return builder;
            },
            then(resolve: (rows: unknown[]) => unknown) {
              return Promise.resolve(rowsFor(name)).then(resolve);
            },
          };
          return builder;
        },
      };
    },
    update(table: unknown) {
      return {
        set(patch: Partial<FolderRowState>) {
          return {
            where(_cond: unknown) {
              if (tableName(table) === "folders") {
                for (const row of state.folders) {
                  if (pendingFilter.parentId !== undefined && row.parentId === pendingFilter.parentId) Object.assign(row, patch);
                  else if (pendingFilter.id !== undefined && row.id === pendingFilter.id) Object.assign(row, patch);
                }
              }
              return Promise.resolve();
            },
          };
        },
      };
    },
    delete(table: unknown) {
      const name = tableName(table);
      return {
        where(_cond: unknown) {
          if (name === "folders") state.folders = state.folders.filter((r) => r.id !== pendingFilter.id);
          if (name === "folder_queues") state.folderQueues = state.folderQueues.filter((r) => r.folderId !== pendingFilter.folderId);
          return Promise.resolve();
        },
      };
    },
  };

  function rowsFor(name: string): unknown[] {
    if (name === "folders") {
      return state.folders.filter((r) => pendingFilter.id === undefined || r.id === pendingFilter.id);
    }
    if (name === "folder_queues") {
      return state.folderQueues.filter((r) => pendingFilter.folderId === undefined || r.folderId === pendingFilter.folderId);
    }
    return [];
  }

  return db as unknown as Db & {
    __state: { folders: FolderRowState[]; folderQueues: FolderQueueState[] };
    __setFilter(f: { id?: string; parentId?: string; folderId?: string }): void;
  };
}

/** drizzle keeps the SQL name on a symbol; read it without importing internals. */
function tableName(table: unknown): string {
  const sym = Object.getOwnPropertySymbols(table as object).find((s) => String(s).includes("Name"));
  return sym ? String((table as Record<symbol, unknown>)[sym]) : "";
}

const PARENT: FolderRowState = { id: "parent", name: "Payments", color: "#5b8def", parentId: null, position: 0 };
const CHILD_A: FolderRowState = { id: "child-a", name: "Billing", color: null, parentId: "parent", position: 1 };
const CHILD_B: FolderRowState = { id: "child-b", name: "Refunds", color: null, parentId: "parent", position: 2 };

describe("FoldersService.remove", () => {
  let db: ReturnType<typeof fakeDb>;
  let service: FoldersService;

  beforeEach(() => {
    db = fakeDb(
      [{ ...PARENT }, { ...CHILD_A }, { ...CHILD_B }],
      [
        { folderId: "parent", connectionId: "conn-1", queueName: "checkout" },
        { folderId: "child-a", connectionId: "conn-1", queueName: "invoices" },
      ],
    );
    service = new FoldersService(db);
  });

  it("promotes subfolders to the top level instead of deleting them", async () => {
    db.__setFilter({ id: "parent" });
    // get() resolves the folder, then the service switches to the child/queue
    // filters as it walks the delete.
    const remove = service.remove("parent");
    db.__setFilter({ id: "parent", parentId: "parent", folderId: "parent" });
    await remove;

    expect(db.__state.folders.map((f) => f.id)).toEqual(["child-a", "child-b"]);
    expect(db.__state.folders.every((f) => f.parentId === null)).toBe(true);
  });

  it("drops the folder's own queue assignments and keeps the subfolders'", async () => {
    db.__setFilter({ id: "parent" });
    const remove = service.remove("parent");
    db.__setFilter({ id: "parent", parentId: "parent", folderId: "parent" });
    await remove;

    expect(db.__state.folderQueues).toEqual([{ folderId: "child-a", connectionId: "conn-1", queueName: "invoices" }]);
  });

  it("404s on a folder that does not exist", async () => {
    db.__setFilter({ id: "nope" });
    await expect(service.remove("nope")).rejects.toBeInstanceOf(HttpError);
    expect(db.__state.folders).toHaveLength(3);
  });
});
