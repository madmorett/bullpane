import { useCallback, useSyncExternalStore } from "react";
import { useAuth } from "@/auth/AuthProvider";
import { readStorage, writeStorage } from "./storage";

/**
 * The sidebar's personal layout: pinned queues and folders, and a custom order for any list
 * (connections, folders, the queues inside each). One entry per user id, so two
 * people sharing a browser keep their own; the free edition's anonymous admin
 * is just another id.
 *
 * ponytail: localStorage, so it does not follow the user to another browser.
 * Move it to a per-user server table if anyone asks for that.
 */
export interface SidebarLayout {
  /** `queueRef()` / `folderRef()` values, in display order */
  pinned: string[];
  /** list key → item ids in the order the user dragged them into */
  order: Record<string, string[]>;
}

export const queueRef = (connectionId: string, queueName: string) => `${connectionId}/${queueName}`;
/** Connection ids never contain ":", so this cannot collide with a queue ref. */
export const folderRef = (folderId: string) => `folder:${folderId}`;

/** Saved order first, then anything the user never placed (new queues, new folders) in its default order. */
export function applyOrder<T>(items: T[], idOf: (item: T) => string, saved: string[] | undefined): T[] {
  if (!saved?.length) return items;
  const rank = new Map(saved.map((id, i) => [id, i]));
  return items
    .map((item, i) => ({ item, i, r: rank.get(idOf(item)) ?? Infinity }))
    .sort((a, b) => a.r - b.r || a.i - b.i)
    .map((x) => x.item);
}

/** `ids` with `id` moved to where `target` is. */
export function moveId(ids: string[], id: string, target: string): string[] {
  const from = ids.indexOf(id);
  const to = ids.indexOf(target);
  if (from < 0 || to < 0 || from === to) return ids;
  const next = [...ids];
  next.splice(from, 1);
  next.splice(to, 0, id);
  return next;
}

const cache = new Map<string, SidebarLayout>();
const listeners = new Set<() => void>();

const storageKey = (userId: string) => `sidebar.layout.${userId}`;

function load(userId: string): SidebarLayout {
  let layout = cache.get(userId);
  if (!layout) {
    const raw = readStorage<Partial<SidebarLayout> | null>(storageKey(userId), null);
    layout = {
      pinned: Array.isArray(raw?.pinned) ? raw.pinned : [],
      order: raw?.order && typeof raw.order === "object" ? raw.order : {},
    };
    cache.set(userId, layout);
  }
  return layout;
}

function save(userId: string, layout: SidebarLayout) {
  cache.set(userId, layout);
  writeStorage(storageKey(userId), layout);
  // The desktop rail and the mobile drawer are two Sidebar instances.
  listeners.forEach((l) => l());
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

/** The layout of whoever is signed in. Pins are set from the sidebar, the Overview's cards and its table. */
export function useSidebarLayout() {
  const id = useAuth().user?.id ?? "anonymous";
  const layout = useSyncExternalStore(subscribe, () => load(id));

  const togglePin = useCallback(
    (ref: string) => {
      const cur = load(id);
      const pinned = cur.pinned.includes(ref) ? cur.pinned.filter((r) => r !== ref) : [...cur.pinned, ref];
      save(id, { ...cur, pinned });
    },
    [id],
  );

  /** `ids` is the list as currently displayed; the pinned list is its own order. */
  const move = useCallback(
    (list: string, ids: string[], dragged: string, target: string) => {
      const cur = load(id);
      const next = moveId(ids, dragged, target);
      if (next === ids) return;
      save(id, list === "pinned" ? { ...cur, pinned: next } : { ...cur, order: { ...cur.order, [list]: next } });
    },
    [id],
  );

  return { layout, togglePin, move };
}
