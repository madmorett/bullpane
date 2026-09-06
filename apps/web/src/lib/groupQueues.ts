import type { Folder, QueueSummary, RedisConnection } from "@bullmq-visualizer/shared";

export interface QueueEntry {
  connection: RedisConnection;
  queue: QueueSummary;
}

export interface QueueSection {
  id: string;
  title: string;
  /** folder colour or undefined for implicit / leftover sections */
  color?: string | null;
  kind: "folder" | "connection" | "leftover";
  items: QueueEntry[];
}

export const entryKey = (e: QueueEntry) => `${e.connection.id}/${e.queue.name}`;

/**
 * Group queues bull-board style.
 *  - Pro with folders: one section per folder (subfolders flattened as "Parent / Child"),
 *    then "Queues without folder" for the rest.
 *  - Free / no folders: one implicit section per connection, nothing left over.
 * A queue may live in several folders and then appears in each.
 */
export function groupQueues(entries: QueueEntry[], folders: Folder[] | undefined | null): QueueSection[] {
  const sections: QueueSection[] = [];

  if (folders && folders.length > 0) {
    const byKey = new Map(entries.map((e) => [entryKey(e), e]));
    const placed = new Set<string>();
    const roots = folders.filter((f) => !f.parentId).sort(byPosition);
    const childrenOf = (id: string) => folders.filter((f) => f.parentId === id).sort(byPosition);

    const push = (folder: Folder, title: string) => {
      const items: QueueEntry[] = [];
      for (const ref of folder.queues) {
        const k = `${ref.connectionId}/${ref.queueName}`;
        const hit = byKey.get(k);
        if (!hit) continue; // folder references a queue not in this view (other connection, gone)
        items.push(hit);
        placed.add(k);
      }
      if (items.length > 0) sections.push({ id: `folder:${folder.id}`, title, color: folder.color, kind: "folder", items: sortItems(items) });
    };

    for (const root of roots) {
      push(root, root.name);
      for (const child of childrenOf(root.id)) push(child, `${root.name} / ${child.name}`);
    }

    const leftovers = entries.filter((e) => !placed.has(entryKey(e)));
    if (leftovers.length > 0) sections.push({ id: "leftover", title: "Queues without folder", kind: "leftover", items: sortItems(leftovers) });
    return sections;
  }

  // implicit folder per connection
  const byConn = new Map<string, QueueSection>();
  for (const e of entries) {
    let s = byConn.get(e.connection.id);
    if (!s) {
      s = { id: `conn:${e.connection.id}`, title: e.connection.name, kind: "connection", items: [] };
      byConn.set(e.connection.id, s);
    }
    s.items.push(e);
  }
  for (const s of byConn.values()) s.items = sortItems(s.items);
  return [...byConn.values()];
}

function byPosition(a: Folder, b: Folder) {
  return a.position - b.position || a.name.localeCompare(b.name);
}

/** failed first, then busiest, then by name — the same priority the overview table used. */
function sortItems(items: QueueEntry[]): QueueEntry[] {
  return [...items].sort((a, b) => b.queue.counts.failed - a.queue.counts.failed || b.queue.counts.waiting - a.queue.counts.waiting || a.queue.name.localeCompare(b.queue.name));
}

export interface QueueTotals {
  queues: number;
  paused: number;
  waiting: number;
  active: number;
  failed: number;
  delayed: number;
  completed: number;
}

export function totals(entries: QueueEntry[]): QueueTotals {
  return entries.reduce<QueueTotals>(
    (acc, { queue }) => {
      acc.queues += 1;
      if (queue.isPaused) acc.paused += 1;
      acc.waiting += queue.counts.waiting + queue.counts.prioritized;
      acc.active += queue.counts.active;
      acc.failed += queue.counts.failed;
      acc.delayed += queue.counts.delayed;
      acc.completed += queue.counts.completed;
      return acc;
    },
    { queues: 0, paused: 0, waiting: 0, active: 0, failed: 0, delayed: 0, completed: 0 },
  );
}

export function matchesFilter(e: QueueEntry, filter: string): boolean {
  const f = filter.trim().toLowerCase();
  if (!f) return true;
  return e.queue.name.toLowerCase().includes(f) || e.connection.name.toLowerCase().includes(f);
}
