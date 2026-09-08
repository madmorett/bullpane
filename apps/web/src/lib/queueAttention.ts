import { DEFAULT_ATTENTION_THRESHOLDS, type AttentionThresholds } from "@bullpane/shared";
import type { QueueEntry } from "./groupQueues";

/**
 * Which queues earn a card on the Overview.
 *
 * With one connection every queue could be a card. With ten it cannot: 81 cards
 * push the sortable table five screens down and nobody scrolls that far. So the
 * cards stop being "all queues" and become "the queues something is wrong with",
 * which is both shorter and the reason someone opened the dashboard.
 *
 * A queue is flagged only for things an operator would act on, in this order:
 *   1. failing   — jobs failed inside the rate window (not the lifetime `failed`
 *                  count, which never resets and would flag every old queue forever)
 *   2. paused    — nothing is draining it
 *   3. backlog   — waiting jobs but no active ones and no worker finishing anything,
 *                  which is what a stopped/absent worker looks like from Redis
 *   4. waiting   — waiting jobs over the configured threshold EVEN WITH a worker
 *                  draining them: the producer is winning. Off by default, because
 *                  there is no depth that is wrong for every workload.
 *   5. failed    — a non-empty failed list even though the window was quiet, so a
 *                  pile of dead jobs from before the window is still visible. When
 *                  a threshold is configured it replaces "non-empty" as the bar.
 */
export type AttentionReason = "failing" | "paused" | "backlog" | "waiting" | "failed";

export interface AttentionItem {
  entry: QueueEntry;
  reasons: AttentionReason[];
  /** higher sorts first */
  score: number;
}

export const REASON_LABEL: Record<AttentionReason, string> = {
  failing: "failing now",
  paused: "paused",
  backlog: "backlog, no worker",
  waiting: "backlog over threshold",
  failed: "failed jobs",
};

/** waiting jobs above this with nothing active is treated as a stuck queue */
const BACKLOG_MIN = 1;

export function attentionReasons(entry: QueueEntry, thresholds: AttentionThresholds = DEFAULT_ATTENTION_THRESHOLDS): AttentionReason[] {
  const q = entry.queue;
  const c = q.counts;
  const reasons: AttentionReason[] = [];

  const failedInWindow = q.rates?.failed ?? 0;
  const finishedInWindow = (q.rates?.completed ?? 0) + failedInWindow;

  if (failedInWindow > 0) reasons.push("failing");
  if (q.isPaused) reasons.push("paused");

  const waiting = c.waiting + c.prioritized;
  // A backlog only matters when nothing is chewing through it. `active > 0` or a
  // queue that finished work in the window has a live worker, so waiting is normal.
  const stuck = waiting >= BACKLOG_MIN && c.active === 0 && finishedInWindow === 0 && !q.isPaused;
  if (stuck) reasons.push("backlog");

  // The depth rule is the other half: a queue WITH a worker can still be losing
  // to its producer. Only flagged when the admin set a number, and never stacked
  // on top of "backlog, no worker" — two chips for one pile reads as two problems.
  if (!stuck && thresholds.waitingAbove > 0 && waiting > thresholds.waitingAbove) reasons.push("waiting");

  // A configured threshold replaces the "any failed job at all" bar; without one
  // the original behaviour stands, so upgrading changes nothing until it is set.
  if (thresholds.failedAbove > 0) {
    if (c.failed > thresholds.failedAbove) reasons.push("failed");
  } else if (reasons.length === 0 && c.failed > 0) {
    reasons.push("failed");
  }

  return reasons;
}

/**
 * Magnitude only breaks ties inside a tier — it never promotes one.
 *
 * The tiers are 50k apart and job counts routinely run into the millions, so an
 * unclamped `+ waiting` let a deep-but-healthy queue outrank a stuck one. Log
 * scale keeps "worse within the tier" working (10 waiting < 10k waiting) while
 * staying under the gap for any count Redis can hold.
 */
function magnitude(n: number): number {
  return n > 0 ? Math.min(Math.log10(n + 1) * 1_000, 9_999) : 0;
}

export function scoreAttention(entry: QueueEntry, reasons: AttentionReason[]): number {
  const q = entry.queue;
  const c = q.counts;
  let score = 0;
  if (reasons.includes("failing")) score += 1_000_000 + magnitude(q.rates?.failed ?? 0);
  if (reasons.includes("paused")) score += 500_000 + magnitude(c.waiting + c.active);
  if (reasons.includes("backlog")) score += 100_000 + magnitude(c.waiting + c.prioritized);
  // below "no worker" (a stuck queue is worse than a deep one) and above a
  // stale failed pile, which nobody is losing throughput to right now.
  if (reasons.includes("waiting")) score += 50_000 + magnitude(c.waiting + c.prioritized);
  if (reasons.includes("failed")) score += magnitude(c.failed);
  return score;
}

export interface AttentionSplit {
  attention: AttentionItem[];
  /** everything that is not flagged, in the caller's original order */
  rest: QueueEntry[];
}

/**
 * Split the queues into "needs attention" and the rest.
 *
 * `max` caps the card section so a genuinely broken fleet (say 60 failing queues)
 * does not recreate the wall we are removing — the overflow is reported by the
 * caller and lives in the table below, which is sortable by failed.
 */
/**
 * 8, not 12: with 10 connections, 12 cards took up the whole screen and pushed the
 * per-connection groups below the fold — the user saw only a wall of broken queues,
 * with no context. 8 fits in two rows and keeps the groups visible.
 */
export function splitByAttention(
  entries: QueueEntry[],
  thresholds: AttentionThresholds = DEFAULT_ATTENTION_THRESHOLDS,
  max = 8,
): AttentionSplit & { hidden: number } {
  const flagged: AttentionItem[] = [];
  const rest: QueueEntry[] = [];

  for (const entry of entries) {
    const reasons = attentionReasons(entry, thresholds);
    if (reasons.length > 0) flagged.push({ entry, reasons, score: scoreAttention(entry, reasons) });
    else rest.push(entry);
  }

  flagged.sort((a, b) => b.score - a.score || a.entry.queue.name.localeCompare(b.entry.queue.name));

  return {
    attention: spreadAcrossConnections(flagged, max),
    hidden: Math.max(0, flagged.length - max),
    // queues that were flagged but did not fit stay out of `rest` too: they are
    // in the table, and repeating them in a collapsed group would double-count.
    rest,
  };
}

/**
 * Pick `max` items round-robin over connections, worst-first inside each.
 *
 * A straight `slice(0, max)` fills the section with whichever queue name is
 * worst — and when the same worker code is deployed against several Redises,
 * that is literally the same queue name repeated once per connection. Twelve
 * cards showed three distinct queues across four connections. Round-robin means
 * each connection contributes its worst before any contributes its second, so
 * the section shows breadth of problems instead of one problem four times.
 */
function spreadAcrossConnections(flagged: AttentionItem[], max: number): AttentionItem[] {
  if (flagged.length <= max) return flagged;

  const byConnection = new Map<string, AttentionItem[]>();
  for (const item of flagged) {
    const id = item.entry.connection.id;
    const bucket = byConnection.get(id);
    if (bucket) bucket.push(item);
    else byConnection.set(id, [item]);
  }

  // connection order follows its worst queue, so the worst fleet-wide card is still first
  const buckets = [...byConnection.values()];
  const out: AttentionItem[] = [];
  for (let round = 0; out.length < max; round++) {
    let placed = false;
    for (const bucket of buckets) {
      if (round >= bucket.length) continue;
      out.push(bucket[round]);
      placed = true;
      if (out.length === max) break;
    }
    if (!placed) break; // every bucket exhausted
  }
  return out;
}
