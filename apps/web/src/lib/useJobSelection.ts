import { useCallback, useMemo, useRef, useState } from "react";

/**
 * Job selection in a table that reloads every 3 s.
 *
 * The decision that makes this work: the selection is stored by **jobId**, never
 * by index. The table repolls and the rows swap positions (that's the cause of
 * the wrong-target mistakes that already happen today); a stored index points at
 * a different job on the next cycle, and the operator removes the wrong job.
 *
 * The second decision: a selected id that LEFT the visible page stays selected.
 * Dropping it silently would be worse than any alternative — the operator
 * clicked it. The UI shows "3 selected (2 not on this page)" and
 * `visibleSelected` vs `selectedIds` keeps both counts available.
 */
export interface JobSelection {
  /** every selected id, including the ones that are not on the current page */
  selectedIds: string[];
  /** how many selected ids are on the visible page right now */
  visibleSelectedCount: number;
  /** selected ids that are not in the visible list (left with the polling/pagination) */
  offPageCount: number;
  /** true when the WHOLE visible page is selected (and the page is not empty) */
  allVisibleSelected: boolean;
  has(jobId: string): boolean;
  toggle(jobId: string): void;
  /** Shift+click: selects/clears the range between the last anchor and this id */
  toggleRange(jobId: string): void;
  /** checks or unchecks the whole visible page, without touching what is off it */
  toggleAllVisible(): void;
  clear(): void;
  /** removes ids from the selection (used after a successful action) */
  deselect(jobIds: string[]): void;
}

/**
 * The selection math, extracted as PURE functions.
 *
 * Reason: the value of these rules is in the behavior under polling (ids that
 * leave the page, an anchor that disappears, a range that flips direction) and
 * that deserves a test. Testing it through a hook would require a DOM; as pure
 * functions, it fits in a node test.
 */

/** Checks or unchecks an id. */
export function applyToggle(selected: ReadonlySet<string>, jobId: string): Set<string> {
  const next = new Set(selected);
  if (next.has(jobId)) next.delete(jobId);
  else next.add(jobId);
  return next;
}

/**
 * Shift+click: applies the range between the anchor and `jobId` WITHIN the
 * visible page. If the anchor is no longer visible (the polling took it off the
 * page), it degrades to a plain click instead of guessing a range.
 *
 * The direction follows the clicked id: clicking an unchecked one selects the
 * range, clicking a checked one clears the range.
 */
export function applyRange(
  selected: ReadonlySet<string>,
  visibleIds: readonly string[],
  anchorId: string | null,
  jobId: string,
): Set<string> {
  const start = anchorId ? visibleIds.indexOf(anchorId) : -1;
  const end = visibleIds.indexOf(jobId);
  if (start < 0 || end < 0) return applyToggle(selected, jobId);
  const [lo, hi] = start <= end ? [start, end] : [end, start];
  const selecting = !selected.has(jobId);
  const next = new Set(selected);
  for (const id of visibleIds.slice(lo, hi + 1)) {
    if (selecting) next.add(id);
    else next.delete(id);
  }
  return next;
}

/**
 * Header: selects the whole visible page, or clears it if it was already fully
 * selected. NEVER touches the selected ids that are off the page — whoever
 * clicked them clicked them on purpose.
 */
export function applyToggleAllVisible(selected: ReadonlySet<string>, visibleIds: readonly string[]): Set<string> {
  const all = visibleIds.length > 0 && visibleIds.every((id) => selected.has(id));
  const next = new Set(selected);
  for (const id of visibleIds) {
    if (all) next.delete(id);
    else next.add(id);
  }
  return next;
}

/** How many selected ids are on the visible page right now. */
export function countVisibleSelected(selected: ReadonlySet<string>, visibleIds: readonly string[]): number {
  return visibleIds.reduce((n, id) => (selected.has(id) ? n + 1 : n), 0);
}

export function useJobSelection(visibleIds: string[]): JobSelection {
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
  /** last clicked id, the anchor for Shift+click */
  const anchor = useRef<string | null>(null);

  const has = useCallback((jobId: string) => selected.has(jobId), [selected]);

  const toggle = useCallback((jobId: string) => {
    anchor.current = jobId;
    setSelected((prev) => applyToggle(prev, jobId));
  }, []);

  const toggleRange = useCallback(
    (jobId: string) => {
      const from = anchor.current;
      anchor.current = jobId;
      setSelected((prev) => applyRange(prev, visibleIds, from, jobId));
    },
    [visibleIds],
  );

  const visibleSelectedCount = useMemo(() => countVisibleSelected(selected, visibleIds), [visibleIds, selected]);
  const allVisibleSelected = visibleIds.length > 0 && visibleSelectedCount === visibleIds.length;

  const toggleAllVisible = useCallback(() => {
    setSelected((prev) => applyToggleAllVisible(prev, visibleIds));
    anchor.current = null;
  }, [visibleIds]);

  const clear = useCallback(() => {
    setSelected(new Set());
    anchor.current = null;
  }, []);

  const deselect = useCallback((jobIds: string[]) => {
    setSelected((prev) => {
      const next = new Set(prev);
      for (const id of jobIds) next.delete(id);
      return next;
    });
  }, []);

  const selectedIds = useMemo(() => [...selected], [selected]);

  return {
    selectedIds,
    visibleSelectedCount,
    offPageCount: selectedIds.length - visibleSelectedCount,
    allVisibleSelected,
    has,
    toggle,
    toggleRange,
    toggleAllVisible,
    clear,
    deselect,
  };
}
