import { useEffect, useMemo, useState } from "react";
import { useDelayedGroups } from "@/api/hooks";
import { mergeDelayedSlices } from "@/lib/groupRows";

/**
 * Scan calls chained on their own before "scan more": 40 × 2500 jobs = 100k per round,
 * each call a few ms of Redis with the connection free in between.
 */
const AUTO_CALLS = 40;
/**
 * How often a COMPLETE scan is redone, so a group whose delayed jobs became due (and
 * that Pro now indexes) stops showing as "delayed only". Only when the whole state
 * fit in one round of AUTO_CALLS slices: a bigger state is refreshed on "scan more"
 * or after an action, never on a timer.
 */
const REFRESH_MS = 30_000;

/**
 * Delayed jobs per BullMQ Pro group. Pro keeps them in the queue's `delayed` zset,
 * not under the group, and counts them nowhere, so they come from a bounded scan of
 * `delayed` (GET /groups-delayed), summed across the slices read so far. `complete`
 * is false while part of the state is unscanned: the counts are lower bounds then.
 */
export function useDelayedGroupCounts(connectionId: string, queue: string, enabled: boolean) {
  const [refresh, setRefresh] = useState(false);
  const scan = useDelayedGroups(connectionId, queue, { enabled, refetchMs: refresh ? REFRESH_MS : false });
  const [roundStart, setRoundStart] = useState(0);
  const pages = scan.data?.pages ?? [];
  const smallAndComplete = !!scan.data && !scan.hasNextPage && pages.length <= AUTO_CALLS;
  useEffect(() => setRefresh(smallAndComplete), [smallAndComplete]);

  useEffect(() => {
    if (enabled && scan.hasNextPage && !scan.isFetching && pages.length - roundStart < AUTO_CALLS) void scan.fetchNextPage();
  }, [enabled, scan, pages.length, roundStart]);

  const counts = useMemo(() => mergeDelayedSlices(pages), [pages]);

  return {
    counts,
    loading: enabled && scan.isLoading,
    complete: !!scan.data && !scan.hasNextPage,
    scanning: scan.isFetching,
    scanned: pages.reduce((n, p) => n + p.scanned, 0),
    total: pages.length ? pages[pages.length - 1].total : 0,
    error: scan.error,
    scanMore: scan.hasNextPage && !scan.isFetching ? () => (setRoundStart(pages.length), void scan.fetchNextPage()) : null,
    refetch: () => void scan.refetch(),
  };
}
