import { cn } from "@/lib/cn";
import { formatCompact, formatNumber } from "@/lib/format";
import { STATE_COLORS, type ColoredState } from "@/lib/stateColors";
import type { QueueTotals } from "@/lib/groupQueues";

/**
 * "All queues" summary: totals across everything in view, coloured with the
 * shared state palette.
 *
 * `hiddenCount` is stated, never folded in. The totals sum only the visible
 * queues — a hidden queue must not quietly pad "13 queues · 187 waiting" — so
 * the count of what was left out is printed next to them, and clicking it
 * reveals the list.
 */
export function QueueTotalsStrip({
  totals,
  title = "All queues",
  className,
  children,
  hiddenCount = 0,
  onRevealHidden,
}: {
  totals: QueueTotals;
  title?: string;
  className?: string;
  children?: React.ReactNode;
  hiddenCount?: number;
  onRevealHidden?: () => void;
}) {
  return (
    <div className={cn("card flex flex-wrap items-center gap-x-5 gap-y-2 px-4 py-2.5", className)}>
      <div className="flex items-baseline gap-2">
        <h2 className="text-xs font-semibold tracking-wider text-fg-subtle uppercase">{title}</h2>
        <span className="num text-xs text-fg-muted">
          {formatNumber(totals.queues)} {totals.queues === 1 ? "queue" : "queues"}
          {totals.paused > 0 && <span className="text-state-paused"> · {formatNumber(totals.paused)} paused</span>}
        </span>
        {hiddenCount > 0 &&
          (onRevealHidden ? (
            <button
              type="button"
              onClick={onRevealHidden}
              className="num text-xs text-fg-subtle underline decoration-dotted underline-offset-2 hover:text-fg-muted"
              title="These queues are hidden and are NOT included in the totals. Click to see them."
            >
              {formatNumber(hiddenCount)} hidden
            </button>
          ) : (
            <span className="num text-xs text-fg-subtle" title="These queues are hidden and are NOT included in the totals.">
              {formatNumber(hiddenCount)} hidden
            </span>
          ))}
      </div>
      <div className="flex flex-wrap items-center gap-4">
        <Total state="waiting" value={totals.waiting} />
        <Total state="active" value={totals.active} />
        <Total state="delayed" value={totals.delayed} />
        <Total state="failed" value={totals.failed} dimZero />
        <Total state="completed" value={totals.completed} />
      </div>
      {children && <div className="ml-auto flex items-center gap-2">{children}</div>}
    </div>
  );
}

function Total({ state, value, dimZero }: { state: ColoredState; value: number; dimZero?: boolean }) {
  const c = STATE_COLORS[state];
  const dim = dimZero && value === 0;
  return (
    <span className="flex items-baseline gap-1.5" title={`${formatNumber(value)} ${c.label}`}>
      <span className={cn("status-dot size-2 self-center", c.dotClass, dim && "opacity-40")} aria-hidden />
      <span className={cn("num text-sm font-semibold", dim ? "text-fg-muted" : c.textClass)}>{formatCompact(value)}</span>
      <span className="text-xs text-fg-subtle">{c.label}</span>
    </span>
  );
}
