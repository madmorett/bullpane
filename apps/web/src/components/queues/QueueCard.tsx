import { Link } from "react-router-dom";
import { Search } from "lucide-react";
import type { QueueRates } from "@bullmq-visualizer/shared";
import { cn } from "@/lib/cn";
import { routes } from "@/lib/routes";
import { formatNumber, formatPercent } from "@/lib/format";
import { PRIMARY_STATES, SECONDARY_STATES, STATE_COLORS } from "@/lib/stateColors";
import type { QueueEntry } from "@/lib/groupQueues";
import { Badge } from "@/components/ui/Badge";
import { Sparkline } from "@/components/ui/Sparkline";
import { StateChip } from "@/components/StateBadge";

export function QueueCard({ entry, showConnection }: { entry: QueueEntry; showConnection?: boolean }) {
  const { connection, queue } = entry;
  const c = queue.counts;
  const href = routes.queue(connection.id, queue.name);

  return (
    <article className={cn("queue-card", queue.isPaused && "opacity-90", c.failed > 0 && "border-state-failed/40")} data-testid="queue-card">
      <header className="flex min-w-0 items-start gap-1.5">
        <div className="min-w-0 flex-1">
          {/* stretched link: the whole card is clickable, but real buttons stay above it */}
          <Link to={href} className="block truncate font-mono text-[13px] font-semibold text-fg after:absolute after:inset-0 after:content-[''] hover:underline" title={queue.name}>
            {queue.name}
          </Link>
          {showConnection && <div className="truncate text-[11px] text-fg-subtle" title={connection.name}>{connection.name}</div>}
        </div>
        <div className="relative z-10 flex shrink-0 items-center gap-1">
          {queue.isPro && (
            <Badge variant="pro" size="xs" className="tracking-wider" title={`BullMQ Pro · ${formatNumber(queue.groupsCount)} groups`}>
              PRO
            </Badge>
          )}
          {queue.isPaused && (
            <Badge variant="warning" size="xs" className="tracking-wider">
              PAUSED
            </Badge>
          )}
          <Link to={routes.queueSearch(connection.id, queue.name)} className="rounded p-0.5 text-fg-subtle hover:bg-surface-2 hover:text-fg" title="Search jobs in this queue" aria-label={`Search jobs in ${queue.name}`}>
            <Search className="size-3.5" />
          </Link>
        </div>
      </header>

      <div className="flex flex-wrap gap-1">
        {PRIMARY_STATES.map((s) => (
          <StateChip key={s} state={s} count={c[s]} />
        ))}
        {SECONDARY_STATES.map((s) => (
          <StateChip key={s} state={s} count={c[s]} hideZero short />
        ))}
      </div>

      <footer className="mt-auto flex items-center gap-2 border-t border-border pt-2">
        <SuccessBar rates={queue.rates} className="min-w-0 flex-1" />
        {queue.metrics && queue.metrics.completed.length > 1 && (
          <span className="shrink-0" style={{ color: STATE_COLORS.completed.fg }}>
            <Sparkline values={queue.metrics.completed} width={56} height={14} title="Completed per minute" />
          </span>
        )}
      </footer>
    </article>
  );
}

export function windowLabel(minutes: number | undefined): string {
  if (!minutes) return "1h";
  if (minutes % 1440 === 0) return `${minutes / 1440}d`;
  if (minutes % 60 === 0) return `${minutes / 60}h`;
  return `${minutes}m`;
}

/** Green-vs-red bar for the trailing-window success rate. Honest about "no data". */
export function SuccessBar({ rates, className, compact }: { rates: QueueRates | undefined; className?: string; compact?: boolean }) {
  const pct = rates?.successPct ?? null;
  const finished = (rates?.completed ?? 0) + (rates?.failed ?? 0);
  const win = windowLabel(rates?.windowMinutes);
  const title = rates ? `${formatNumber(rates.completed)} completed · ${formatNumber(rates.failed)} failed in the last ${win}` : "no rate data";
  return (
    <div className={cn("flex flex-col gap-1", className)} title={title}>
      <div className="flex h-1.5 w-full overflow-hidden rounded-full bg-surface-3" role="img" aria-label={pct == null ? `No finished jobs in the last ${win}` : `${formatPercent(pct)} success in the last ${win}`}>
        {pct != null && (
          <>
            <span className="h-full" style={{ width: `${pct}%`, background: STATE_COLORS.completed.fg }} />
            <span className="h-full flex-1" style={{ background: STATE_COLORS.failed.fg, opacity: pct >= 100 ? 0 : 1 }} />
          </>
        )}
      </div>
      {!compact && (
        <span className="num truncate text-[11px] text-fg-muted">
          {pct == null ? (
            <span className="text-fg-subtle">no finished jobs · {win}</span>
          ) : (
            <>
              <span className={cn("font-medium", pct < 90 ? "text-state-failed" : "text-fg")}>{formatPercent(pct)} ok</span>
              <span className="text-fg-subtle"> · {win}</span>
              {finished > 0 && <span className="text-fg-subtle"> · {formatNumber(finished)} finished</span>}
            </>
          )}
        </span>
      )}
    </div>
  );
}
