import { useMemo } from "react";
import type { JobState } from "@bullmq-visualizer/shared";
import { cn } from "@/lib/cn";
import { formatCompact, formatNumber, formatPercent } from "@/lib/format";
import { STATE_COLORS } from "@/lib/stateColors";
import { sumSeries } from "@/lib/queueMetrics";
import type { QueueEntry } from "@/lib/groupQueues";
import { Sparkline } from "@/components/ui/Sparkline";
import { Tooltip } from "@/components/ui/Tooltip";
import { SKEW_TOOLTIP } from "@/components/queues/RateSource";
import { TriangleAlert } from "lucide-react";

const BOXES: JobState[] = ["waiting", "active", "completed", "failed", "delayed"];

export interface FolderAggregate {
  counts: Record<JobState, number>;
  completed: number;
  failed: number;
  /** weighted across every queue's trailing-window rates; null when nothing finished anywhere */
  successPct: number | null;
  /** element-wise sum of the per-minute completed arrays */
  completedSeries: number[];
  failedSeries: number[];
  /** how many queues actually contribute metrics */
  withMetrics: number;
  windowMinutes: number | null;
  /**
   * Queues whose rates the server flagged as skewed by `removeOnComplete` pruning.
   * One of them is enough to make the aggregate percentage untrustworthy, since it
   * is a weighted sum of the raw counts.
   */
  skewedQueues: string[];
}

export function aggregate(entries: QueueEntry[]): FolderAggregate {
  const counts = {
    waiting: 0,
    active: 0,
    completed: 0,
    failed: 0,
    delayed: 0,
    prioritized: 0,
    paused: 0,
    "waiting-children": 0,
  } as Record<JobState, number>;

  let completed = 0;
  let failed = 0;
  let withMetrics = 0;
  let windowMinutes: number | null = null;
  const skewedQueues: string[] = [];

  for (const { queue } of entries) {
    for (const s of Object.keys(counts) as JobState[]) counts[s] += queue.counts[s] ?? 0;
    // weighted success: raw completed/failed counts across the window, not a mean of percentages
    completed += queue.rates?.completed ?? 0;
    failed += queue.rates?.failed ?? 0;
    if (queue.rates?.windowMinutes) windowMinutes = queue.rates.windowMinutes;
    if (queue.metrics && queue.metrics.completed.length > 0) withMetrics += 1;
    if (queue.rates?.retentionSkewed) skewedQueues.push(queue.name);
  }

  const finished = completed + failed;
  return {
    counts,
    completed,
    failed,
    successPct: finished > 0 ? (completed / finished) * 100 : null,
    // queues without metrics simply contribute nothing (sumSeries skips empties)
    completedSeries: sumSeries(entries.map((e) => e.queue.metrics?.completed)),
    failedSeries: sumSeries(entries.map((e) => e.queue.metrics?.failed)),
    withMetrics,
    windowMinutes,
    skewedQueues,
  };
}

export function FolderMetrics({ entries, className }: { entries: QueueEntry[]; className?: string }) {
  const agg = useMemo(() => aggregate(entries), [entries]);
  const win = agg.windowMinutes ? (agg.windowMinutes % 60 === 0 ? `${agg.windowMinutes / 60}h` : `${agg.windowMinutes}m`) : "1h";
  const hasSeries = agg.completedSeries.length > 1;
  const skewed = agg.skewedQueues.length > 0;
  const skewNote = skewed
    ? `${agg.skewedQueues.length === 1 ? `Queue "${agg.skewedQueues[0]}"` : `${agg.skewedQueues.length} queues (${agg.skewedQueues.slice(0, 3).join(", ")}${agg.skewedQueues.length > 3 ? ", …" : ""})`} feed this total. ${SKEW_TOOLTIP}`
    : "";

  return (
    <div className={cn("grid gap-2 sm:grid-cols-3 xl:grid-cols-7", className)}>
      {BOXES.map((s) => {
        const c = STATE_COLORS[s];
        const v = agg.counts[s];
        return (
          <div key={s} className="card px-3 py-2.5">
            <div className="flex items-center gap-1.5 text-[10px] font-medium tracking-wider text-fg-subtle uppercase">
              <span className={cn("status-dot size-1.5", c.dotClass)} aria-hidden />
              {c.label}
            </div>
            <div className={cn("num text-2xl leading-tight font-semibold", v > 0 ? c.textClass : "text-fg-muted")}>{formatCompact(v)}</div>
          </div>
        );
      })}

      <div className="card px-3 py-2.5">
        <div className="flex items-center gap-1 text-[10px] font-medium tracking-wider text-fg-subtle uppercase">
          Success · {win}
          {skewed && (
            <Tooltip content={skewNote} className="ml-auto">
              <TriangleAlert className="size-3 text-warning" aria-label="This total is unreliable: some queues prune completed jobs" />
            </Tooltip>
          )}
        </div>
        <Tooltip content={`${formatNumber(agg.completed)} completed · ${formatNumber(agg.failed)} failed across ${entries.length} ${entries.length === 1 ? "queue" : "queues"}${skewed ? `\n\n${skewNote}` : ""}`}>
          <div
            className={cn(
              "num text-2xl leading-tight font-semibold",
              skewed && "opacity-50",
              agg.successPct == null ? "text-fg-subtle" : agg.successPct < 90 ? "text-state-failed" : "text-state-completed",
            )}
          >
            {agg.successPct == null ? "—" : formatPercent(agg.successPct)}
          </div>
        </Tooltip>
        <div className={cn("mt-1 flex h-1.5 w-full overflow-hidden rounded-full bg-surface-3", skewed && "opacity-50")} role="img" aria-label={agg.successPct == null ? "No finished jobs" : `${formatPercent(agg.successPct)} success${skewed ? ", unreliable: some queues prune completed jobs" : ""}`}>
          {agg.successPct != null && (
            <>
              <span className="h-full" style={{ width: `${agg.successPct}%`, background: STATE_COLORS.completed.fg }} />
              <span className="h-full flex-1" style={{ background: STATE_COLORS.failed.fg, opacity: agg.successPct >= 100 ? 0 : 1 }} />
            </>
          )}
        </div>
      </div>

      <div className="card flex flex-col px-3 py-2.5">
        <div className="text-[10px] font-medium tracking-wider text-fg-subtle uppercase">Completed / min</div>
        {hasSeries ? (
          <>
            <span className="mt-1 block" style={{ color: STATE_COLORS.completed.fg }}>
              <Sparkline values={agg.completedSeries} width={140} height={30} title="Combined completed per minute" className="w-full" />
            </span>
            <span className="mt-auto text-[10px] text-fg-subtle">
              {formatNumber(agg.withMetrics)} of {formatNumber(entries.length)} queues report metrics
            </span>
          </>
        ) : (
          <span className="mt-2 text-[11px] leading-relaxed text-fg-subtle">
            No queue in this folder collects metrics.
          </span>
        )}
      </div>
    </div>
  );
}
