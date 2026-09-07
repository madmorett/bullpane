import { Link } from "react-router-dom";
import type { ConnectionHealth, HealthWarning } from "@bullpane/shared";
import { Activity, ChevronDown, ChevronRight, OctagonAlert, Pause } from "lucide-react";
import { cn } from "@/lib/cn";
import { routes } from "@/lib/routes";
import { errorMessage } from "@/api/client";
import { usePersistedToggle } from "@/lib/usePersistedToggle";
import { formatBytes, formatCpuPercent, formatLatency, formatPercent, formatRate } from "@/lib/format";
import { Tooltip } from "@/components/ui/Tooltip";
import { cpuTooltip, cpuWarnTone } from "./cpu";
import { aggregate, useHealthMonitor } from "./useHealthMonitor";

/**
 * Redis health for the Overview, in the smallest shape that still tells the truth.
 *
 * Up to INLINE_MAX connections it is one line per connection, stacked
 * vertically — never two connections sharing a row. Above that the block
 * becomes a summary ("10 connections · 9 ok · 1 with problems · 11.9K cmd/s ·
 * 8% cpu") with a disclosure that opens the same one-row-per-connection list.
 *
 * The old version put all connections in a single `overflow-x-auto` row, which
 * with ten connections showed two and hid eight behind a scrollbar nobody finds
 * — the last visible name was even cut mid-word. Nothing here scrolls sideways:
 * it either aggregates or stacks.
 *
 * Deliberately NOT here: sparklines, the Details disclosure, per-connection
 * tiles. `warn` warnings are only the colour of the status dot plus a tooltip;
 * `critical` gets a real banner, because that one you must not scroll past.
 */

/** at or below this many connections, every connection keeps its own inline line */
const INLINE_MAX = 4;

export function RedisHealthStrip({ className }: { className?: string }) {
  const { health, paused, isLoading, error } = useHealthMonitor();
  const [expanded, toggleExpanded] = usePersistedToggle("overview.health.expanded", false);

  const critical = health.flatMap((h) =>
    h.warnings.filter((w) => w.level === "critical").map((w) => ({ health: h, warning: w })),
  );
  const down = health.filter((h) => !h.ok);

  if (!isLoading && health.length === 0 && error == null) return null;

  const collapsible = health.length > INLINE_MAX;

  return (
    <section aria-label="Redis health" className={cn("space-y-2", className)}>
      {critical.length > 0 && <CriticalBanner items={critical} />}

      <div className="card px-2 py-1.5">
        <div className="flex items-center gap-2">
          <Activity className={cn("size-3.5 shrink-0 text-fg-subtle", paused && "opacity-50")} aria-hidden />

          {isLoading && health.length === 0 ? (
            <span className="min-w-0 flex-1 text-[11px] text-fg-subtle">Reading Redis health…</span>
          ) : error != null && health.length === 0 ? (
            <span className="min-w-0 flex-1 truncate text-[11px] text-danger">Could not load health: {errorMessage(error)}</span>
          ) : collapsible ? (
            <AggregateLine health={health} paused={paused} expanded={expanded} onToggle={toggleExpanded} />
          ) : (
            /* few connections: one row per connection, stacked — never sharing a line */
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              {health.map((h) => (
                <ConnectionLine key={h.connectionId} health={h} paused={paused} />
              ))}
            </div>
          )}

          {paused && (
            <Tooltip content="Monitoring is paused — the dashboard is sending no INFO commands. These are the last numbers received.">
              <span className="flex shrink-0 cursor-help items-center gap-1 text-[11px] text-warning">
                <Pause className="size-3" aria-hidden />
                paused
              </span>
            </Tooltip>
          )}

          {down.length > 0 && !paused && !collapsible && (
            <span className="shrink-0 text-[11px] font-medium text-danger">{down.length} unreachable</span>
          )}

          <Link
            to={routes.health}
            className="shrink-0 rounded-md border border-border px-1.5 py-0.5 text-[11px] text-fg-muted transition-colors hover:border-border-strong hover:text-fg"
          >
            Monitor
          </Link>
        </div>

        {collapsible && expanded && (
          <div className="mt-2 flex flex-col gap-1 border-t border-border pt-2">
            {health.map((h) => (
              <ConnectionLine key={h.connectionId} health={h} paused={paused} className="min-w-0" />
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

/**
 * The collapsed summary. Two rules make this safe to collapse:
 *  - the aggregate numbers are the same ones the top bar shows, so nothing new
 *    is hidden behind the disclosure;
 *  - every connection that is down or critical is NAMED here regardless, because
 *    "1 with problems" without a name is exactly the information you needed.
 */
function AggregateLine({
  health,
  paused,
  expanded,
  onToggle,
}: {
  health: ConnectionHealth[];
  paused: boolean;
  expanded: boolean;
  onToggle: () => void;
}) {
  const agg = aggregate(health);
  const problems = health.filter((h) => !h.ok || h.warnings.some((w) => w.level === "critical"));
  const okCount = agg.total - problems.length;

  return (
    <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-1">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        className="flex shrink-0 items-center gap-1 rounded text-xs font-medium text-fg hover:text-accent"
      >
        {expanded ? <ChevronDown className="size-3.5 text-fg-subtle" aria-hidden /> : <ChevronRight className="size-3.5 text-fg-subtle" aria-hidden />}
        <span className="num">{agg.total} connections</span>
      </button>

      <span className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-fg-muted">
        {okCount > 0 && (
          <span className="flex items-center gap-1.5">
            <span className="status-dot bg-success text-success" aria-hidden />
            <span className="num">{okCount} ok</span>
          </span>
        )}

        {problems.length > 0 ? (
          <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
            <span className="flex shrink-0 items-center gap-1.5 font-medium text-danger">
              <span className="status-dot pulse bg-danger text-danger" aria-hidden />
              <span className="num">{problems.length} with problems</span>
            </span>
            {/* named, always: this is the part that must not be collapsed away */}
            {problems.slice(0, 3).map((h) => (
              <Tooltip
                key={h.connectionId}
                content={h.ok ? h.warnings.map((w) => w.message).join(" · ") : `Unreachable: ${h.error ?? "unknown error"}`}
              >
                <Link
                  to={routes.health}
                  className="max-w-52 shrink-0 cursor-help truncate rounded border border-danger/40 bg-danger/10 px-1.5 py-px text-[11px] font-medium text-danger"
                >
                  {h.connectionName}
                </Link>
              </Tooltip>
            ))}
            {problems.length > 3 && (
              <Link to={routes.health} className="shrink-0 text-[11px] text-danger underline underline-offset-2">
                +{problems.length - 3} more
              </Link>
            )}
          </span>
        ) : (
          agg.warn > 0 && (
            <span className="flex items-center gap-1.5 text-warning">
              <span className="status-dot bg-warning text-warning" aria-hidden />
              <span className="num">
                {agg.warn} warning{agg.warn === 1 ? "" : "s"}
              </span>
            </span>
          )
        )}

        {!paused && (
          <>
            <Metric
              label="cmd/s"
              value={agg.commandsPerSec == null ? "–" : formatRate(agg.commandsPerSec, "")}
              tip={agg.commandsPerSec == null ? "No rate yet — needs two INFO samples. This is not zero." : "Summed across every connection"}
            />
            <Metric
              label="cpu"
              value={formatCpuPercent(agg.cpuCores)}
              tip={`Busiest single Redis — ${cpuTooltip(agg.cpuCores)}`}
              tone={cpuWarnTone(agg.cpuCores)}
            />
            {agg.memoryPct != null && (
              <Metric
                label="mem"
                value={formatPercent(agg.memoryPct, 0)}
                tip="Highest memory use against maxmemory across connections"
                tone={agg.memoryPct >= 90 ? "danger" : agg.memoryPct >= 75 ? "warn" : undefined}
              />
            )}
          </>
        )}
      </span>

      <button type="button" onClick={onToggle} className="shrink-0 text-[11px] text-fg-subtle underline underline-offset-2 hover:text-fg">
        {expanded ? "hide all" : "show all"}
      </button>
    </div>
  );
}

function ConnectionLine({ health, paused, className }: { health: ConnectionHealth; paused: boolean; className?: string }) {
  const info = health.info;
  const down = !health.ok;
  const worst = worstLevel(health.warnings);

  const dotTip = down
    ? `Unreachable: ${health.error ?? "unknown error"}`
    : health.warnings.length > 0
      ? health.warnings.map((w) => w.message).join(" · ")
      : "Responding to INFO";

  return (
    <div className={cn("flex min-w-0 items-center gap-2", paused && "opacity-70", className)}>
      <Tooltip content={dotTip}>
        <span
          className={cn(
            "status-dot shrink-0 cursor-help",
            down
              ? "bg-danger pulse text-danger"
              : worst === "critical"
                ? "bg-danger text-danger"
                : worst === "warn"
                  ? "bg-warning text-warning"
                  : "bg-success text-success",
          )}
          role="img"
          aria-label={down ? "unreachable" : worst ? `${worst} warning` : "ok"}
        />
      </Tooltip>

      <Link
        to={routes.health}
        className="min-w-0 flex-1 truncate text-xs font-medium text-fg hover:underline"
        title={health.connectionName}
      >
        {health.connectionName}
      </Link>

      {down ? (
        <span className="min-w-0 flex-1 truncate text-[11px] text-danger">{health.error ?? "Redis is unreachable"}</span>
      ) : (
        <span className="flex shrink-0 items-center gap-x-3 text-[11px] text-fg-muted">
          <Metric
            label="mem"
            value={info ? info.usedMemoryHuman || formatBytes(info.usedMemoryBytes) : "–"}
            tip={
              health.memoryUsedPct != null && info?.maxMemoryBytes
                ? `${formatPercent(health.memoryUsedPct)} of ${formatBytes(info.maxMemoryBytes)} maxmemory`
                : "used_memory — no maxmemory set on this Redis"
            }
            tone={
              health.memoryUsedPct == null
                ? undefined
                : health.memoryUsedPct >= 90
                  ? "danger"
                  : health.memoryUsedPct >= 75
                    ? "warn"
                    : undefined
            }
          />
          <Metric label="cpu" value={formatCpuPercent(health.cpuCores)} tip={cpuTooltip(health.cpuCores)} tone={cpuWarnTone(health.cpuCores)} />
          <Metric
            label="cmd/s"
            value={health.commandsPerSec == null ? "–" : formatRate(health.commandsPerSec, "")}
            tip={
              health.commandsPerSec == null
                ? "No rate yet — needs two INFO samples. This is not zero."
                : "Derived from total_commands_processed between samples"
            }
          />
          <Metric label="lat" value={info ? formatLatency(info.latencyMs) : "–"} tip="Round trip of the INFO command itself" />
        </span>
      )}
    </div>
  );
}

function Metric({
  label,
  value,
  tip,
  tone,
}: {
  label: string;
  value: string;
  tip: string;
  tone?: "warn" | "danger";
}) {
  return (
    <Tooltip content={tip}>
      <span className="cursor-help items-baseline gap-1 whitespace-nowrap">
        <span className={cn("num font-medium", tone === "danger" ? "text-danger" : tone === "warn" ? "text-warning" : "text-fg")}>
          {value}
        </span>
        <span className="ml-1 text-fg-subtle">{label}</span>
      </span>
    </Tooltip>
  );
}

function CriticalBanner({ items }: { items: { health: ConnectionHealth; warning: HealthWarning }[] }) {
  return (
    <div
      role="status"
      className="flex items-start gap-2 rounded-md border border-danger/40 bg-danger/10 px-2.5 py-1.5 text-xs text-danger"
    >
      <OctagonAlert className="mt-px size-3.5 shrink-0" aria-hidden />
      <div className="min-w-0 flex-1 space-y-0.5 leading-snug">
        {items.map(({ health, warning }, i) => (
          <p key={`${health.connectionId}-${warning.code}-${i}`} className="truncate">
            <span className="font-semibold">{health.connectionName}</span>
            <span className="mx-1.5 opacity-50">·</span>
            {warning.message}
          </p>
        ))}
      </div>
      <Link to={routes.health} className="shrink-0 underline underline-offset-2 hover:no-underline">
        Monitor
      </Link>
    </div>
  );
}

function worstLevel(warnings: HealthWarning[]): "critical" | "warn" | null {
  let seen: "critical" | "warn" | null = null;
  for (const w of warnings) {
    if (w.level === "critical") return "critical";
    seen = "warn";
  }
  return seen;
}
