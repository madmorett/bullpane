import { useCallback, useMemo } from "react";
import { useSearchParams } from "react-router-dom";
import { readStorage, writeStorage } from "./storage";

export type SortDir = "asc" | "desc";
export interface SortState {
  key: string;
  dir: SortDir;
}

/**
 * Sort + text filter for a table, persisted in the URL (`?sort=&dir=&filter=`)
 * so they survive polling refetches and reloads, with the last sort remembered
 * in localStorage as a fallback for the next visit.
 */
export function useTableState(storageKey: string, defaultSort: SortState, validKeys?: readonly string[]) {
  const [sp, setSp] = useSearchParams();

  const sort = useMemo<SortState>(() => {
    const fromUrl = parseSort(sp.get("sort"), sp.get("dir"), validKeys);
    if (fromUrl) return fromUrl;
    const stored = readStorage<SortState | null>(`table.${storageKey}.sort`, null);
    if (stored && typeof stored === "object" && parseSort(stored.key, stored.dir, validKeys)) return stored;
    return defaultSort;
  }, [sp, storageKey, defaultSort, validKeys]);

  const filter = sp.get("filter") ?? "";

  const setSort = useCallback(
    (next: SortState) => {
      writeStorage(`table.${storageKey}.sort`, next);
      setSp(
        (prev) => {
          const n = new URLSearchParams(prev);
          n.set("sort", next.key);
          n.set("dir", next.dir);
          return n;
        },
        { replace: true },
      );
    },
    [setSp, storageKey],
  );

  const setFilter = useCallback(
    (value: string) => {
      setSp(
        (prev) => {
          const n = new URLSearchParams(prev);
          if (value.trim()) n.set("filter", value);
          else n.delete("filter");
          return n;
        },
        { replace: true },
      );
    },
    [setSp],
  );

  return { sort, setSort, filter, setFilter };
}

function parseSort(key: string | null | undefined, dir: string | null | undefined, validKeys?: readonly string[]): SortState | null {
  if (!key) return null;
  if (validKeys && !validKeys.includes(key)) return null;
  return { key, dir: dir === "asc" ? "asc" : "desc" };
}
