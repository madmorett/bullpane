/**
 * The groups table's row logic, kept pure so it is tested apart from React: the
 * delayed-jobs scan arrives in slices to add up, some groups exist only there, and
 * those "delayed only" rows continue the server-paged indexed groups in one list.
 */
import type { DelayedGroupsPage, GroupStatus } from "@bullpane/shared";

export interface DelayedGroupCount {
  delayed: number;
  nextRunAt: number;
  /** place in Pro's index as of the latest slice that saw the group; null = not indexed */
  status: GroupStatus | null;
}

/** Adds the scan's slices up: counts summed, soonest run kept, the latest status wins. */
export function mergeDelayedSlices(pages: readonly DelayedGroupsPage[]): Map<string, DelayedGroupCount> {
  const byId = new Map<string, DelayedGroupCount>();
  for (const p of pages) {
    for (const g of p.groups) {
      const seen = byId.get(g.id);
      if (seen) {
        seen.delayed += g.delayed;
        seen.nextRunAt = Math.min(seen.nextRunAt, g.nextRunAt);
        seen.status = g.status;
      } else byId.set(g.id, { delayed: g.delayed, nextRunAt: g.nextRunAt, status: g.status });
    }
  }
  return byId;
}

/**
 * Groups Pro does not index, most delayed first. A group the (polled) table already
 * shows as indexed is left out whatever the (older) scan said.
 */
export function delayedOnlyGroups(counts: ReadonlyMap<string, DelayedGroupCount>, indexedOnScreen: ReadonlySet<string>): ({ id: string } & DelayedGroupCount)[] {
  return [...counts.entries()]
    .filter(([id, c]) => c.status === null && !indexedOnScreen.has(id))
    .map(([id, c]) => ({ id, ...c }))
    .sort((x, y) => y.delayed - x.delayed || x.id.localeCompare(y.id));
}

/**
 * One row space: rows [0, indexedTotal) are the indexed groups the server pages, the
 * rest the delayed-only list. Returns the delayed-only rows of `page`, and the last
 * page of the whole list.
 */
export function pageOfRows<T>(delayedOnly: readonly T[], opts: { indexedTotal: number; page: number; pageSize: number }): { delayedOnly: T[]; lastPage: number } {
  const start = (opts.page - 1) * opts.pageSize;
  return {
    delayedOnly: delayedOnly.slice(Math.max(0, start - opts.indexedTotal), Math.max(0, start + opts.pageSize - opts.indexedTotal)),
    lastPage: Math.max(1, Math.ceil((opts.indexedTotal + delayedOnly.length) / opts.pageSize)),
  };
}
