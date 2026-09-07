import { Link } from "react-router-dom";
import { AlertTriangle, CheckCircle2 } from "lucide-react";
import { cn } from "@/lib/cn";
import { routes } from "@/lib/routes";
import { formatNumber } from "@/lib/format";
import { REASON_LABEL, type AttentionItem, type AttentionReason } from "@/lib/queueAttention";
import { QueueCard } from "./QueueCard";

/**
 * The top of the Overview: the queues that are failing, paused or stuck.
 *
 * This is the section that replaces "every queue as a card". With 81 queues the
 * card wall was noise; the handful that are actually broken is the reason
 * someone opened the page, and a handful still fits above the fold.
 */
export function QueueAttentionSection({
  items,
  hidden,
  showConnection,
  filtered,
  className,
}: {
  items: AttentionItem[];
  hidden: number;
  showConnection?: boolean;
  /** a text filter is active, so "all clear" would be a lie about the whole fleet */
  filtered?: boolean;
  className?: string;
}) {
  if (items.length === 0) {
    return (
      <section aria-label="Needs attention" className={cn("card flex items-center gap-2 px-4 py-2.5", className)}>
        <CheckCircle2 className="size-4 shrink-0 text-state-completed" aria-hidden />
        <p className="text-xs text-fg-muted">
          {filtered ? "Nothing matching the filter needs attention" : "No queue needs attention"}
          <span className="text-fg-subtle"> — nothing failing, paused or backed up without a worker.</span>
        </p>
      </section>
    );
  }

  return (
    <section aria-label="Needs attention" className={className}>
      <h2 className="mb-1.5 flex items-center gap-1.5 text-[11px] font-semibold tracking-wider text-fg-subtle uppercase">
        <AlertTriangle className="size-3.5 text-warning" aria-hidden />
        <span className="normal-case tracking-normal text-fg-muted">Needs attention</span>
        <span className="num font-normal">{formatNumber(items.length + hidden)}</span>
        {hidden > 0 && (
          <span className="font-normal normal-case tracking-normal text-fg-subtle">
            · showing the {items.length} worst, the rest are in the table below
          </span>
        )}
      </h2>

      <div className="grid gap-2" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(230px, 1fr))" }}>
        {items.map(({ entry, reasons }) => (
          <div key={`${entry.connection.id}/${entry.queue.name}`} className="relative flex flex-col gap-1">
            <QueueCard entry={entry} showConnection={showConnection} />
            <div className="flex flex-wrap gap-1">
              {reasons.map((r) => (
                <ReasonChip key={r} reason={r} />
              ))}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

const REASON_TONE: Record<AttentionReason, string> = {
  failing: "border-state-failed/40 bg-state-failed/10 text-state-failed",
  paused: "border-state-paused/40 bg-state-paused/10 text-state-paused",
  backlog: "border-warning/40 bg-warning/10 text-warning",
  failed: "border-state-failed/30 bg-state-failed/5 text-state-failed",
};

function ReasonChip({ reason }: { reason: AttentionReason }) {
  return (
    <span className={cn("rounded border px-1.5 py-px text-[10px] font-medium", REASON_TONE[reason])}>{REASON_LABEL[reason]}</span>
  );
}

/** compact link used when a connection group has flagged queues of its own */
export function AttentionCount({ connectionId, count }: { connectionId: string; count: number }) {
  if (count === 0) return null;
  return (
    <Link to={routes.connection(connectionId)} className="num text-[11px] text-state-failed hover:underline">
      {formatNumber(count)} need attention
    </Link>
  );
}
