import { Link } from "react-router-dom";
import { Activity } from "lucide-react";
import { cn } from "@/lib/cn";
import { routes } from "@/lib/routes";
import { formatCpuPercent, formatPercent, formatRate } from "@/lib/format";
import { Tooltip } from "@/components/ui/Tooltip";
import { cpuTooltip } from "./cpu";
import { aggregate, useHealthMonitor } from "./useHealthMonitor";

/**
 * The whole health picture squeezed into one line of the top bar:
 * "N conn · X cmd/s · Y% mem". Deliberately subtle — it is a glance, not a gauge.
 */
export function HealthTopBarSummary({ className }: { className?: string }) {
  const { health, paused } = useHealthMonitor();
  if (health.length === 0) return null;

  const agg = aggregate(health);
  const bad = agg.down > 0 || agg.critical > 0;
  const warn = !bad && agg.warn > 0;

  const tip = paused
    ? "Health monitoring is paused. Open the monitor to resume."
    : [
        `${agg.total} connection${agg.total === 1 ? "" : "s"}`,
        agg.down > 0 ? `${agg.down} unreachable` : null,
        agg.commandsPerSec == null ? "commands/sec: measuring…" : `${formatRate(agg.commandsPerSec)} across all connections`,
        agg.memoryPct == null ? "no maxmemory set" : `peak memory use ${formatPercent(agg.memoryPct)} of maxmemory`,
        agg.cpuCores == null ? null : `busiest CPU ${formatCpuPercent(agg.cpuCores)} of one core — ${cpuTooltip(agg.cpuCores)}`,
        agg.critical > 0 ? `${agg.critical} critical warning${agg.critical === 1 ? "" : "s"}` : null,
        agg.warn > 0 ? `${agg.warn} warning${agg.warn === 1 ? "" : "s"}` : null,
      ]
        .filter(Boolean)
        .join(" · ");

  return (
    <Tooltip content={tip} side="bottom">
      <Link
        to={routes.health}
        aria-label="Redis health monitor"
        className={cn(
          "hidden items-center gap-1.5 rounded-md border border-border bg-bg px-2 py-1 text-xs text-fg-muted transition-colors hover:border-border-strong hover:text-fg md:flex",
          bad && "border-danger/50 text-danger",
          warn && "border-warning/50 text-warning",
          paused && "opacity-60",
          className,
        )}
      >
        <Activity className={cn("size-3.5 shrink-0", paused && "opacity-50")} aria-hidden />
        <span className="num whitespace-nowrap">
          {agg.total} conn
          <span className="mx-1 text-fg-subtle">·</span>
          {paused ? "paused" : agg.commandsPerSec == null ? "—" : `${formatRate(agg.commandsPerSec, "")} cmd/s`}
          {agg.cpuCores != null && !paused && (
            <>
              <span className="mx-1 text-fg-subtle">·</span>
              {formatCpuPercent(agg.cpuCores)} cpu
            </>
          )}
          {agg.memoryPct != null && (
            <>
              <span className="mx-1 text-fg-subtle">·</span>
              {formatPercent(agg.memoryPct, 0)} mem
            </>
          )}
        </span>
      </Link>
    </Tooltip>
  );
}
