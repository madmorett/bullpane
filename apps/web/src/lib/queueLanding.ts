import type { JobState, QueueCounts } from "@bullpane/shared";

/**
 * Which state a click on a queue should land on.
 *
 * The problem this solves: every entry point (card, table row, sidebar) showed
 * a red `failed` counter and none of them took you there — `routes.queue()` was
 * called without `state` and QueuePage fell back to `waiting`. You clicked a
 * queue with 1,000 failures and read "No jobs in this state". A wasted click in
 * 100% of incidents.
 *
 * The rule, in order:
 *   1. `failed > 0`  → `failed`. If there are failures, that's what the operator came for.
 *   2. `waiting > 0` → `waiting`. With no failures, what matters is the inbound queue.
 *   3. otherwise     → `completed`. Healthy, empty queue: show the history, which
 *                      is the only tab with content. Landing on `waiting` here
 *                      means landing on an empty table.
 *
 * `prioritized` counts as waiting (it's the inbound queue with priority), but the
 * destination stays `waiting`, which is the tab the operator looks for; a
 * `waiting: 0 / prioritized: 5` goes to `prioritized`, otherwise the click would
 * land on an empty table again.
 *
 * Pure function on purpose: it's the heart of the fix and has its own test.
 */
export function queueLandingState(counts: Partial<QueueCounts> | undefined): JobState {
  const failed = counts?.failed ?? 0;
  if (failed > 0) return "failed";
  const waiting = counts?.waiting ?? 0;
  if (waiting > 0) return "waiting";
  const prioritized = counts?.prioritized ?? 0;
  if (prioritized > 0) return "prioritized";
  return "completed";
}
