import { useState } from "react";
import type { ConnectionHealth, HealthPoint } from "@bullmq-visualizer/shared";
import { ChevronRight, Cpu, Gauge, HardDrive, Key, Users, Zap } from "lucide-react";
import { cn } from "@/lib/cn";
import {
  formatBytes,
  formatCompact,
  formatCores,
  formatCpuPercent,
  formatLatency,
  formatNumber,
  formatPercent,
  formatRate,
  formatRatio,
  formatUptime,
} from "@/lib/format";
import { useNow } from "@/lib/useNow";
import { Badge } from "@/components/ui/Badge";
import { Tooltip } from "@/components/ui/Tooltip";
import { cpuMeterTone, cpuTooltip } from "./cpu";
import { DetailRow, StatTile, Unknown, WarningBanner } from "./parts";

/** Rates the server could not derive yet. Same wording everywhere. */
const NO_RATE_YET =
  "No rate yet — needs two INFO samples. Also resets when Redis restarts. This is not zero.";

export function sampleAgeSeconds(h: ConnectionHealth, now: number): number | null {
  if (!h.info) return null;
  const t = Date.parse(h.info.sampledAt);
  if (!Number.isFinite(t)) return null;
  return Math.max(0, Math.round((now - t) / 1000));
}

function series<K extends keyof HealthPoint>(history: HealthPoint[], key: K): (number | null)[] {
  return history.map((p) => {
    const v = p[key];
    return typeof v === "number" && Number.isFinite(v) ? v : null;
  });
}

export function HealthConnectionCard({
  health,
  big,
  paused,
}: {
  health: ConnectionHealth;
  /** the /health page variant: bigger charts, details open by default */
  big?: boolean;
  paused?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const now = useNow(1_000);
  const info = health.info;
  const down = !health.ok;
  const age = sampleAgeSeconds(health, now);
  const history = health.history ?? [];
  // When Redis is unreachable we keep the last known shape on screen, dimmed,
  // rather than blanking the card — the shape right before it went down is
  // exactly what you want to look at.
  const dim = down;

  return (
    <section
      aria-label={`Redis health for ${health.connectionName}`}
      className={cn(
        "card flex min-w-0 flex-col gap-3 p-3",
        down && "border-danger/50 bg-danger/[0.04]",
        paused && "opacity-70",
      )}
    >
      <header className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        <Tooltip content={down ? `Unreachable: ${health.error ?? "unknown error"}` : "Responding to INFO"}>
          <span
            className={cn("status-dot", down ? "bg-danger pulse text-danger" : "bg-success text-success")}
            role="img"
            aria-label={down ? "unreachable" : "ok"}
          />
        </Tooltip>
        <h3 className="min-w-0 truncate text-sm font-semibold text-fg">{health.connectionName}</h3>
        {info && (
          <>
            <Badge variant="outline" size="xs" mono>
              {info.redisVersion}
            </Badge>
            <Badge variant="neutral" size="xs">
              {info.mode}
            </Badge>
            <Tooltip content="Redis process uptime">
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
            <Tooltip content={info ? `Sampled at ${new Date(info.sampledAt).toLocaleTimeString()}` : ""}>
              <span className="num cursor-help">sampled {age}s ago</span>
            </Tooltip>
          )}
        </span>
      </header>

      {down && (
        <p className="rounded-md border border-danger/40 bg-danger/10 px-2.5 py-1.5 font-mono text-[11px] break-words text-danger">
          {health.error ?? "Redis is unreachable"}
        </p>
      )}

      {health.warnings.length > 0 && (
        <div className="flex flex-col gap-1.5">
          {health.warnings
            // `unreachable` is already the red error block above; don't say it twice.
            .filter((w) => !(down && w.code === "unreachable"))
            .map((w, i) => (
              <WarningBanner key={`${w.code}-${i}`} warning={w} />
            ))}
        </div>
      )}

      <div
        className={cn("grid gap-2", big ? "sm:grid-cols-2 lg:grid-cols-3" : "grid-cols-2 sm:grid-cols-3")}
      >
        <StatTile
          label="Memory"
          big={big}
          dimmed={dim}
          isUnknown={!info}
          unknownReason="No sample"
          value={info ? info.usedMemoryHuman || formatBytes(info.usedMemoryBytes) : null}
          hint={
            <span className="flex items-center gap-1">
              <HardDrive className="size-3" aria-hidden /> used_memory
            </span>
          }
          meterPct={health.memoryUsedPct}
          meterLabel={
            health.memoryUsedPct != null && info?.maxMemoryBytes
              ? `${formatPercent(health.memoryUsedPct)} of ${formatBytes(info.maxMemoryBytes)}`
              : "no maxmemory set"
          }
          meterTone={
            health.memoryUsedPct == null ? "ok" : health.memoryUsedPct >= 90 ? "danger" : health.memoryUsedPct >= 75 ? "warn" : "ok"
          }
          spark={series(history, "memoryBytes")}
          sparkColor="var(--violet)"
          sparkTitle="Used memory"
        />

        <StatTile
          label="CPU"
          big={big}
          dimmed={dim}
          isUnknown={health.cpuCores == null}
          unknownReason={NO_RATE_YET}
          // Percent of ONE core is the number that means something for a
          // single-threaded Redis. Cores stay on screen, just smaller.
          value={formatCpuPercent(health.cpuCores)}
          secondary={
            health.cpuCores == null ? (
              "measuring…"
            ) : (
              <Tooltip content={cpuTooltip(health.cpuCores)}>
                <span className="num cursor-help border-b border-dotted border-border-strong">
                  {formatCores(health.cpuCores)}
                </span>
              </Tooltip>
            )
          }
          hint={
            <span className="flex items-center gap-1">
              <Cpu className="size-3" aria-hidden /> used_cpu_sys + used_cpu_user, per second, as a share of one
              core. 100% = one saturated core.
            </span>
          }
          meterPct={health.cpuCores == null ? null : health.cpuCores * 100}
          meterLabel={
            health.cpuCores == null
              ? "measuring…"
              : health.cpuCores > 1
                ? "over 1 core"
                : "of 1 core"
          }
          meterTone={health.cpuCores == null ? "ok" : cpuMeterTone(health.cpuCores)}
          spark={series(history, "cpuCores")}
          sparkColor="var(--teal)"
          sparkTitle="CPU (share of one core)"
        />

        <StatTile
          label="Commands/sec"
          big={big}
          dimmed={dim}
          isUnknown={health.commandsPerSec == null}
          unknownReason={NO_RATE_YET}
          value={formatRate(health.commandsPerSec)}
          secondary={health.commandsPerSec == null ? "measuring…" : undefined}
          hint={
            <span className="flex items-center gap-1">
              <Zap className="size-3" aria-hidden /> derived from total_commands_processed between samples
            </span>
          }
          spark={series(history, "commandsPerSec")}
          sparkColor="var(--accent)"
          sparkTitle="Commands per second"
        />

        <StatTile
          label="Latency"
          big={big}
          dimmed={dim}
          isUnknown={!info}
          unknownReason="No sample"
          value={info ? formatLatency(info.latencyMs) : null}
          hint={
            <span className="flex items-center gap-1">
              <Gauge className="size-3" aria-hidden /> round trip of the INFO command itself
            </span>
          }
          spark={series(history, "latencyMs")}
          sparkColor="var(--warning)"
          sparkTitle="INFO latency"
        />

        <StatTile
          label="Clients"
          big={big}
          dimmed={dim}
          isUnknown={!info}
          unknownReason="No sample"
          value={info ? formatNumber(info.connectedClients) : null}
          hint={
            <span className="flex items-center gap-1">
              <Users className="size-3" aria-hidden /> connected_clients
            </span>
          }
          secondary={
            info?.blockedClients != null ? (
              <Tooltip content="Blocked clients are normal for BullMQ: workers sit in BRPOPLPUSH waiting for the next job. A number close to your worker count is healthy, not a stall.">
                <span className="cursor-help border-b border-dotted border-border-strong">
                  {formatNumber(info.blockedClients)} blocked
                </span>
              </Tooltip>
            ) : undefined
          }
          spark={series(history, "connectedClients")}
          sparkColor="var(--info)"
          sparkTitle="Connected clients"
        />

        <StatTile
          label="Keys"
          big={big}
          dimmed={dim}
          isUnknown={!info || info.totalKeys == null}
          unknownReason="Redis did not report a keyspace (empty db, or cluster)"
          value={info ? formatCompact(info.totalKeys) : null}
          hint={
            <span className="flex items-center gap-1">
              <Key className="size-3" aria-hidden /> total keys across the keyspace
            </span>
          }
        />
      </div>

      <details
        open={open}
        onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}
        className="rounded-md border border-border bg-bg/40"
      >
        <summary className="flex cursor-pointer list-none items-center gap-1.5 px-2.5 py-1.5 text-[11px] text-fg-muted select-none hover:text-fg">
          <ChevronRight className={cn("size-3.5 transition-transform", open && "rotate-90")} aria-hidden />
          Details
        </summary>
        <dl className="grid gap-x-6 px-2.5 pb-2 sm:grid-cols-2 lg:grid-cols-3">
          <DetailRow
            label="RSS"
            value={info ? formatBytes(info.usedMemoryRssBytes) : "—"}
            hint="used_memory_rss — what the OS actually holds for the Redis process"
          />
          <DetailRow label="Peak memory" value={info ? formatBytes(info.usedMemoryPeakBytes) : "—"} hint="used_memory_peak" />
          <DetailRow
            label="Fragmentation"
            value={info ? formatRatio(info.memFragmentationRatio) : "—"}
            tone={info?.memFragmentationRatio != null && info.memFragmentationRatio > 1.5 ? "warn" : undefined}
            hint="mem_fragmentation_ratio — above 1.5 the allocator is wasting memory"
          />
          <DetailRow
            label="Maxmemory policy"
            value={info?.maxMemoryPolicy ?? "—"}
            tone={info?.maxMemoryPolicy && info.maxMemoryPolicy !== "noeviction" ? "warn" : undefined}
            hint="Anything other than noeviction can silently delete queue keys under memory pressure"
          />
          <DetailRow
            label="Hit rate"
            value={info?.keyspaceHitRatePct != null ? formatPercent(info.keyspaceHitRatePct) : "—"}
            hint="keyspace_hits / (hits + misses), cumulative since start"
          />
          <DetailRow
            label="Evicted keys"
            value={info ? formatNumber(info.evictedKeys) : "—"}
            tone={info?.evictedKeys != null && info.evictedKeys > 0 ? "danger" : "muted"}
            hint="Non-zero on a queue Redis means jobs were deleted to free memory"
          />
          <DetailRow label="Expired keys" value={info ? formatNumber(info.expiredKeys) : "—"} tone="muted" hint="expired_keys, cumulative" />
          <DetailRow
            label="Rejected connections"
            value={info ? formatNumber(info.rejectedConnections) : "—"}
            tone={info?.rejectedConnections != null && info.rejectedConnections > 0 ? "warn" : "muted"}
            hint="Non-zero means maxclients was hit at some point since start"
          />
          <DetailRow
            label="Replicas"
            value={info?.connectedReplicas != null ? formatNumber(info.connectedReplicas) : "—"}
            hint="connected_slaves"
          />
          <DetailRow
            label="Persistence"
            value={info?.persistenceOk == null ? "—" : info.persistenceOk ? "ok" : "failing"}
            tone={info?.persistenceOk === false ? "danger" : undefined}
            hint="rdb_last_bgsave_status / aof_last_write_status"
          />
          <DetailRow
            label="Commands processed"
            value={info ? formatCompact(info.totalCommandsProcessed) : "—"}
            hint="total_commands_processed, cumulative since start"
          />
          <DetailRow label="History points" value={formatNumber(history.length)} tone="muted" hint="Kept in the server's memory, not persisted" />
        </dl>
      </details>
    </section>
  );
}
