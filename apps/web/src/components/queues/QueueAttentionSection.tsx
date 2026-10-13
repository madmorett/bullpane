import { Link } from "react-router-dom";
import { AlertTriangle, BellOff, CheckCircle2, Info } from "lucide-react";
import type { AttentionFinding } from "@bullpane/shared";
import { cn } from "@/lib/cn";
import { routes } from "@/lib/routes";
import { formatNumber } from "@/lib/format";
import { REASON_LABEL, type AttentionItem, type AttentionReason } from "@/lib/queueAttention";
import { Tooltip } from "@/components/ui/Tooltip";
import { QueueCard } from "./QueueCard";

/** Pro: the section is driven by alert rules; this says how many and what they could not see. */
export interface AttentionRulesInfo {
  rules: number;
  /** queues a rule covers but cannot measure (no BullMQ metrics) */
  unmeasured: number;
}

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
  rules,
  className,
}: {
  items: AttentionItem[];
  hidden: number;
  showConnection?: boolean;
  /** a text filter is active, so "all clear" would be a lie about the whole fleet */
  filtered?: boolean;
  /** Pro only */
  rules?: AttentionRulesInfo;
  className?: string;
}) {
  const unmeasured = rules && rules.unmeasured > 0 && (
    <Tooltip content="Their Workers keep no BullMQ metrics, so failure rules cannot judge them. Turn on metrics: { maxDataPoints } in the Worker options.">
      <Link to={routes.alerts} className="inline-flex items-center gap-1 text-[11px] text-fg-subtle hover:text-fg">
        <Info className="size-3" aria-hidden />
        {formatNumber(rules.unmeasured)} {rules.unmeasured === 1 ? "queue" : "queues"} not measurable
      </Link>
    </Tooltip>
  );

  if (items.length === 0) {
    return (
      <section aria-label="Needs attention" className={cn("card flex flex-wrap items-center gap-2 px-4 py-2.5", className)}>
        <CheckCircle2 className="size-4 shrink-0 text-state-completed" aria-hidden />
        <p className="text-xs text-fg-muted">
          {filtered ? "Nothing matching the filter needs attention" : "No queue needs attention"}
          <span className="text-fg-subtle">
            {rules
              ? rules.rules > 0
                ? ` — no rule broken, nothing paused or stuck. `
                : " — nothing paused or stuck, and no rule is set. "
              : " — nothing failing, paused or over the thresholds."}
          </span>
          {rules && (
            <Link to={routes.alerts} className="text-accent hover:underline">
              {rules.rules > 0 ? `${rules.rules} ${rules.rules === 1 ? "rule" : "rules"} watching` : "Add a rule"}
            </Link>
          )}
        </p>
        {unmeasured}
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
        {/* Next to the heading it qualifies, not pushed to the far right where it read as unrelated. */}
        {unmeasured && <span className="ml-1 font-normal normal-case tracking-normal">· {unmeasured}</span>}
      </h2>

      <div className="grid gap-2" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(230px, 1fr))" }}>
        {items.map(({ entry, reasons, findings }) => (
          <div key={`${entry.connection.id}/${entry.queue.name}`} className="relative flex flex-col gap-1">
            <QueueCard entry={entry} showConnection={showConnection} />
            <div className="flex flex-wrap gap-1">
              {findings.map((f) => (
                <FindingChip key={f.alertId} finding={f} />
              ))}
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
  waiting: "border-warning/40 bg-warning/10 text-warning",
  failed: "border-state-failed/30 bg-state-failed/5 text-state-failed",
};

const FINDING_TONE: Record<AttentionFinding["kind"], string> = {
  failed_rate_above: REASON_TONE.failing,
  failed_above: REASON_TONE.failing,
  duration_above: "border-state-delayed/40 bg-state-delayed/10 text-state-delayed",
  waiting_above: REASON_TONE.waiting,
};

function formatFindingValue(f: AttentionFinding, v: number): string {
  if (f.unit === "%") return `${v}%`;
  if (f.unit === "s") return v >= 10 ? `${Math.round(v)}s` : v >= 1 ? `${v.toFixed(1)}s` : `${Math.round(v * 1000)}ms`;
  return formatNumber(v);
}

/** "12.5% failed · 15m > 5%" — the value, the window and the bar, so the chip is the whole story. */
export function findingLabel(f: AttentionFinding): string {
  const win = f.windowMinutes ? ` · ${f.windowMinutes >= 60 && f.windowMinutes % 60 === 0 ? `${f.windowMinutes / 60}h` : `${f.windowMinutes}m`}` : "";
  const bar = ` > ${formatFindingValue(f, f.threshold)}`;
  switch (f.kind) {
    case "failed_rate_above":
      return `${formatFindingValue(f, f.value)} failed${win}${bar}`;
    case "failed_above":
      return `${formatNumber(f.value)} failed${win}${bar}`;
    case "duration_above":
      return `p${f.percentile ?? 95} ${formatFindingValue(f, f.value)}${win}${bar}`;
    case "waiting_above":
      return `${formatNumber(f.value)} waiting${bar}`;
  }
}

function FindingChip({ finding }: { finding: AttentionFinding }) {
  return (
    <Tooltip content={`Rule "${finding.alertName}"${finding.notifies ? "" : " · dashboard only, notifies nobody"}`}>
      <Link
        to={routes.alerts}
        className={cn("inline-flex items-center gap-1 rounded border px-1.5 py-px text-[10px] font-medium hover:brightness-110", FINDING_TONE[finding.kind])}
      >
        {!finding.notifies && <BellOff className="size-2.5 opacity-70" aria-hidden />}
        <span className="num">{findingLabel(finding)}</span>
      </Link>
    </Tooltip>
  );
}

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
