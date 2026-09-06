import type { ReactNode } from "react";
import type { HealthWarning } from "@bullmq-visualizer/shared";
import { AlertTriangle, OctagonAlert } from "lucide-react";
import { cn } from "@/lib/cn";
import { Tooltip } from "@/components/ui/Tooltip";
import { Sparkline } from "@/components/ui/Sparkline";

/**
 * The em dash is the whole point: a rate we do not have yet is NOT zero.
 * `commandsPerSec` and `cpuCores` are null on the first sample and after a
 * Redis restart resets the cumulative counters.
 */
export function Unknown({ reason = "Not available yet" }: { reason?: string }) {
  return (
    <Tooltip content={reason}>
      <span className="cursor-help text-fg-subtle" aria-label={reason}>
        —
      </span>
    </Tooltip>
  );
}

export interface StatTileProps {
  label: string;
  /** null renders as "—", never as 0 */
  value: ReactNode;
  /** why the value is unknown, shown in the tooltip on the em dash */
  unknownReason?: string;
  isUnknown?: boolean;
  hint?: ReactNode;
  secondary?: ReactNode;
  spark?: (number | null)[];
  sparkColor?: string;
  sparkTitle?: string;
  /** 0..100 progress meter under the value */
  meterPct?: number | null;
  meterLabel?: ReactNode;
  meterTone?: "ok" | "warn" | "danger";
  dimmed?: boolean;
  big?: boolean;
  className?: string;
}

export function StatTile({
  label,
  value,
  unknownReason,
  isUnknown,
  hint,
  secondary,
  spark,
  sparkColor = "var(--accent)",
  sparkTitle,
  meterPct,
  meterLabel,
  meterTone = "ok",
  dimmed,
  big,
  className,
}: StatTileProps) {
  const head = (
    <span className="text-[10px] font-medium tracking-wide text-fg-subtle uppercase">{label}</span>
  );
  return (
    <div className={cn("min-w-0 rounded-md border border-border bg-bg/60 px-2.5 py-2", dimmed && "opacity-50", className)}>
      <div className="flex items-center gap-1">
        {hint ? (
          <Tooltip content={hint}>
            <span className="cursor-help border-b border-dotted border-border-strong">{head}</span>
          </Tooltip>
        ) : (
          head
        )}
      </div>
      <div className={cn("num mt-0.5 truncate font-semibold text-fg", big ? "text-xl" : "text-[15px]")}>
        {isUnknown ? <Unknown reason={unknownReason ?? "Not available yet"} /> : value}
      </div>
      {secondary && <div className="mt-0.5 truncate text-[11px] text-fg-muted">{secondary}</div>}
      {meterPct !== undefined && <Meter pct={meterPct} label={meterLabel} tone={meterTone} />}
      {spark && (
        <Sparkline
          values={spark}
          width={big ? 260 : 112}
          height={big ? 44 : 22}
          className="mt-1.5 w-full"
          stroke={sparkColor}
          title={sparkTitle ?? label}
          dimmed={dimmed}
        />
      )}
    </div>
  );
}

export function Meter({
  pct,
  label,
  tone = "ok",
}: {
  pct: number | null | undefined;
  label?: ReactNode;
  tone?: "ok" | "warn" | "danger";
}) {
  const color = tone === "danger" ? "bg-danger" : tone === "warn" ? "bg-warning" : "bg-accent";
  return (
    <div className="mt-1">
      <div className="h-1 w-full overflow-hidden rounded-full bg-surface-3">
        {pct != null && (
          <div
            className={cn("h-full rounded-full transition-[width] duration-500", color)}
            style={{ width: `${Math.max(0, Math.min(100, pct))}%` }}
          />
        )}
      </div>
      {label && <div className="mt-0.5 truncate text-[10px] text-fg-subtle">{label}</div>}
    </div>
  );
}

/**
 * Warnings are rendered EXACTLY as the server sends them. The dashboard does
 * not own the thresholds; if it did, two clients could disagree about whether
 * the same Redis is in trouble.
 */
export function WarningBanner({ warning }: { warning: HealthWarning }) {
  const critical = warning.level === "critical";
  const Icon = critical ? OctagonAlert : AlertTriangle;
  return (
    <div
      role="status"
      className={cn(
        "flex items-start gap-2 rounded-md border px-2.5 py-1.5 text-xs",
        critical
          ? "border-danger/40 bg-danger/10 text-danger"
          : "border-warning/40 bg-warning/10 text-warning",
      )}
    >
      <Icon className="mt-px size-3.5 shrink-0" aria-hidden />
      <span className="min-w-0 flex-1 leading-snug">{warning.message}</span>
      <span className="shrink-0 font-mono text-[10px] opacity-60">{warning.code}</span>
    </div>
  );
}

/** Label / value row used inside the collapsed Details disclosure. */
export function DetailRow({
  label,
  value,
  tone,
  hint,
}: {
  label: string;
  value: ReactNode;
  tone?: "danger" | "warn" | "muted";
  hint?: string;
}) {
  const body = (
    <div className="flex items-baseline justify-between gap-3 border-b border-border/60 py-1 last:border-b-0">
      <dt className="shrink-0 text-[11px] text-fg-subtle">{label}</dt>
      <dd
        className={cn(
          "num min-w-0 truncate text-right text-[12px]",
          tone === "danger" ? "text-danger" : tone === "warn" ? "text-warning" : tone === "muted" ? "text-fg-muted" : "text-fg",
        )}
      >
        {value}
      </dd>
    </div>
  );
  return hint ? (
    <Tooltip content={hint} block>
      {body}
    </Tooltip>
  ) : (
    body
  );
}
