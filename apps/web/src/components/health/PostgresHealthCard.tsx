import { useState } from "react";
import { ChevronRight, Database, Gauge, Table2, Users, Zap } from "lucide-react";
import { cn } from "@/lib/cn";
import { formatBytes, formatCompact, formatLatency, formatNumber, formatPercent, formatRate, formatUptime } from "@/lib/format";
import { useNow } from "@/lib/useNow";
import { Badge } from "@/components/ui/Badge";
import { Tooltip } from "@/components/ui/Tooltip";
import { DetailRow, StatTile, Unknown, WarningBanner } from "./parts";
import { sampleAgeSeconds, series, type HealthCardProps } from "./HealthConnectionCard";

const NO_RATE_YET = "No rate yet — needs two samples. Also resets when Postgres restarts. This is not zero.";

/**
 * Health of a BullMQ Postgres backend. Postgres has no memory ceiling or
 * keyspace to watch; what breaks a queue database is running out of
 * connections and BullMQ's `event` table growing without bound (BullMQ 6 does
 * not trim it).
 */
export function PostgresHealthCard({ health, big, paused }: HealthCardProps) {
  const [open, setOpen] = useState(false);
  const now = useNow(1_000);
  const info = health.info?.backend === "postgres" ? health.info : null;
  const down = !health.ok;
  const age = sampleAgeSeconds(health, now);
  const history = health.history ?? [];
  const connPct = info && info.maxConnections > 0 ? (info.connectedClients / info.maxConnections) * 100 : null;

  return (
    <section
      aria-label={`Postgres health for ${health.connectionName}`}
      className={cn("card flex min-w-0 flex-col gap-3 p-3", down && "border-danger/50 bg-danger/[0.04]", paused && "opacity-70")}
    >
      <header className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        <Tooltip content={down ? `Unreachable: ${health.error ?? "unknown error"}` : "Responding"}>
          <span className={cn("status-dot", down ? "bg-danger pulse text-danger" : "bg-success text-success")} role="img" aria-label={down ? "unreachable" : "ok"} />
        </Tooltip>
        <h3 className="min-w-0 truncate text-sm font-semibold text-fg">{health.connectionName}</h3>
        {info && (
          <>
            <Badge variant="outline" size="xs" mono>
              Postgres {info.serverVersion}
            </Badge>
            <Badge variant="neutral" size="xs" mono>
              {info.schema}
            </Badge>
            <Tooltip content="Postgres server uptime">
              <span className="num cursor-help text-[11px] text-fg-subtle">up {formatUptime(info.uptimeSeconds)}</span>
            </Tooltip>
          </>
        )}
        <span className="ml-auto shrink-0 text-[11px] text-fg-subtle">
          {paused ? (
            <span className="text-warning">paused</span>
          ) : age == null ? (
            <Unknown reason="No successful sample yet" />
          ) : (
            <span className="num">sampled {age}s ago</span>
          )}
        </span>
      </header>

      {down && (
        <p className="rounded-md border border-danger/40 bg-danger/10 px-2.5 py-1.5 font-mono text-[11px] break-words text-danger">
          {health.error ?? "Postgres is unreachable"}
        </p>
      )}

      {health.warnings.length > 0 && (
        <div className="flex flex-col gap-1.5">
          {health.warnings
            .filter((w) => !(down && w.code === "unreachable"))
            .map((w, i) => (
              <WarningBanner key={`${w.code}-${i}`} warning={w} />
            ))}
        </div>
      )}

      <div className={cn("grid gap-2", big ? "sm:grid-cols-2 lg:grid-cols-3" : "grid-cols-2 sm:grid-cols-3")}>
        <StatTile
          label="Connections"
          big={big}
          dimmed={down}
          isUnknown={!info}
          unknownReason="No sample"
          value={info ? formatNumber(info.connectedClients) : null}
          hint={
            <span className="flex items-center gap-1">
              <Users className="size-3" aria-hidden /> sessions on this database (pg_stat_activity)
            </span>
          }
          meterPct={connPct}
          meterLabel={info ? `of ${formatNumber(info.maxConnections)} max_connections` : ""}
          meterTone={connPct == null ? "ok" : connPct >= 90 ? "danger" : connPct >= 75 ? "warn" : "ok"}
          spark={series(history, "connectedClients")}
          sparkColor="var(--info)"
          sparkTitle="Connections"
        />

        <StatTile
          label="Transactions/sec"
          big={big}
          dimmed={down}
          isUnknown={health.commandsPerSec == null}
          unknownReason={NO_RATE_YET}
          value={formatRate(health.commandsPerSec)}
          secondary={health.commandsPerSec == null ? "measuring…" : undefined}
          hint={
            <span className="flex items-center gap-1">
              <Zap className="size-3" aria-hidden /> xact_commit + xact_rollback between samples
            </span>
          }
          spark={series(history, "commandsPerSec")}
          sparkColor="var(--accent)"
          sparkTitle="Transactions per second"
        />

        <StatTile
          label="Latency"
          big={big}
          dimmed={down}
          isUnknown={!info}
          unknownReason="No sample"
          value={info ? formatLatency(info.latencyMs) : null}
          hint={
            <span className="flex items-center gap-1">
              <Gauge className="size-3" aria-hidden /> round trip of the health query itself
            </span>
          }
          spark={series(history, "latencyMs")}
          sparkColor="var(--warning)"
          sparkTitle="Latency"
        />

        <StatTile
          label="Database"
          big={big}
          dimmed={down}
          isUnknown={!info}
          unknownReason="No sample"
          value={info ? formatBytes(info.databaseSizeBytes) : null}
          hint={
            <span className="flex items-center gap-1">
              <Database className="size-3" aria-hidden /> pg_database_size, the whole database
            </span>
          }
          spark={series(history, "memoryBytes")}
          sparkColor="var(--violet)"
          sparkTitle="Database size"
        />

        <StatTile
          label="Jobs table"
          big={big}
          dimmed={down}
          isUnknown={!info}
          unknownReason="No sample"
          value={info ? formatBytes(info.jobTableBytes) : null}
          hint={
            <span className="flex items-center gap-1">
              <Table2 className="size-3" aria-hidden /> BullMQ's job table, with its indexes
            </span>
          }
        />

        <StatTile
          label="Events table"
          big={big}
          dimmed={down}
          isUnknown={!info}
          unknownReason="No sample"
          value={info ? formatBytes(info.eventTableBytes) : null}
          hint={
            <span className="flex items-center gap-1">
              <Table2 className="size-3" aria-hidden /> never trimmed by BullMQ 6: clean it on a schedule
            </span>
          }
        />
      </div>

      <details open={open} onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)} className="rounded-md border border-border bg-bg/40">
        <summary className="flex cursor-pointer list-none items-center gap-1.5 px-2.5 py-1.5 text-[11px] text-fg-muted select-none hover:text-fg">
          <ChevronRight className={cn("size-3.5 transition-transform", open && "rotate-90")} aria-hidden />
          Details
        </summary>
        <dl className="grid gap-x-6 px-2.5 pb-2 sm:grid-cols-2 lg:grid-cols-3">
          <DetailRow label="Cache hit rate" value={info?.cacheHitRatePct != null ? formatPercent(info.cacheHitRatePct) : "—"} hint="blks_hit / (blks_hit + blks_read), cumulative" />
          <DetailRow
            label="Deadlocks"
            value={info ? formatNumber(info.deadlocks) : "—"}
            tone={info?.deadlocks != null && info.deadlocks > 0 ? "warn" : "muted"}
            hint="pg_stat_database.deadlocks, cumulative since the stats reset"
          />
          <DetailRow label="Transactions" value={info ? formatCompact(info.totalTransactions) : "—"} hint="xact_commit + xact_rollback, cumulative" />
          <DetailRow label="History points" value={formatNumber(history.length)} tone="muted" hint="Kept in the server's memory, not persisted" />
        </dl>
      </details>
    </section>
  );
}
