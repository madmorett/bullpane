import type { ReactNode } from "react";
import { TriangleAlert } from "lucide-react";
import type { QueueRates } from "@bullmq-visualizer/shared";
import { cn } from "@/lib/cn";
import { Tooltip } from "@/components/ui/Tooltip";

/**
 * Where a success rate came from, and whether it can be trusted.
 *
 * `zset` rates count only the jobs still sitting in the completed/failed sorted
 * sets. A queue with `removeOnComplete: { count: 50 }` keeps 50 completed but may
 * keep every failure, so 10.000 ok + 100 failed reads as 33 % instead of 99 %.
 * The server flags exactly that case as `retentionSkewed`; we never hide or
 * recompute the number, we show it dimmed and say why it is suspect.
 */

export const SKEW_TOOLTIP =
  "This queue deletes completed jobs (removeOnComplete), so the sorted sets keep far fewer successes than failures and this ratio is probably too low. To measure it for real, create the Worker with metrics: { maxDataPoints: MetricsTime.ONE_WEEK }.";

const METRICS_TOOLTIP = "From BullMQ's own metrics counters, which are recorded when each job finishes — unaffected by removeOnComplete.";

const ZSET_TOOLTIP = "Counted from the completed/failed sorted sets over the trailing window.";

export function isSkewed(rates: QueueRates | undefined | null): boolean {
  return rates?.retentionSkewed === true;
}

/** Explains where the number comes from. Use as the `title`/tooltip of a rate. */
export function rateSourceHint(rates: QueueRates | undefined | null): string {
  if (!rates) return "";
  if (rates.retentionSkewed) return SKEW_TOOLTIP;
  return rates.source === "metrics" ? METRICS_TOOLTIP : ZSET_TOOLTIP;
}

/** Small alert icon shown next to an unreliable success rate. Nothing when it is fine. */
export function SkewWarning({ rates, className }: { rates: QueueRates | undefined | null; className?: string }) {
  if (!isSkewed(rates)) return null;
  return (
    <Tooltip content={SKEW_TOOLTIP} className={className}>
      <TriangleAlert className="size-3 shrink-0 text-warning" aria-label="Success rate is unreliable: this queue prunes completed jobs" />
    </Tooltip>
  );
}

/**
 * Wraps a rendered rate: dims it and appends the warning icon when the reading
 * is skewed. The value itself is always rendered as-is.
 */
export function RateValue({ rates, children, className }: { rates: QueueRates | undefined | null; children: ReactNode; className?: string }) {
  const skewed = isSkewed(rates);
  return (
    <span className={cn("inline-flex items-center gap-1", className)}>
      <span className={cn(skewed && "opacity-50")}>{children}</span>
      <SkewWarning rates={rates} />
    </span>
  );
}
