import { useMemo, useState } from "react";
import type { ConnectionHealth } from "@bullpane/shared";
import { Page, PageHeader } from "@/components/layout/AppShell";
import { Badge } from "@/components/ui/Badge";
import { Table, Td, Th, TableMessage } from "@/components/ui/Table";
import { Tooltip } from "@/components/ui/Tooltip";
import { cn } from "@/lib/cn";
import {
  formatBytes,
  formatCpuPercent,
  formatDateTime,
  formatLatency,
  formatNumber,
  formatRate,
} from "@/lib/format";
import { cpuTooltip } from "@/components/health/cpu";
import { RedisHealthPanel } from "@/components/health/RedisHealthPanel";
import { useHealthMonitor } from "@/components/health/useHealthMonitor";

export function HealthPage() {
  const { health, paused, lastSampleAt } = useHealthMonitor();

  return (
    <Page wide>
      <PageHeader
        title="Redis health monitor"
        description={
          paused
            ? "Paused — the dashboard is sending nothing to Redis."
            : "One INFO per connection every 3 seconds, sampled on the server and shared across tabs."
        }
        actions={
          lastSampleAt != null && !paused ? (
            <span className="num text-[11px] text-fg-subtle">last sample {formatDateTime(lastSampleAt)}</span>
          ) : undefined
        }
      />

      <RedisHealthPanel big headless />

      <section className="mt-6 space-y-3" aria-label="Sample history">
        <h2 className="text-sm font-semibold text-fg">History</h2>
        {health.length === 0 ? (
          <p className="text-xs text-fg-subtle">No connections to show.</p>
        ) : (
          health.map((h) => <HistoryTable key={h.connectionId} health={h} />)
        )}
      </section>
    </Page>
  );
}

const PAGE_SIZE = 40;

/**
 * The raw samples behind the sparklines, newest first. `null` rates stay "—":
 * they mean the server had no second reading to diff, not that Redis was idle.
 */
function HistoryTable({ health }: { health: ConnectionHealth }) {
  const [expanded, setExpanded] = useState(false);
  const rows = useMemo(() => [...(health.history ?? [])].reverse(), [health.history]);
  const shown = expanded ? rows : rows.slice(0, PAGE_SIZE);

  return (
    <div className="card overflow-hidden">
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2">
        <span
          className={cn("status-dot", health.ok ? "bg-success text-success" : "bg-danger text-danger")}
          role="img"
          aria-label={health.ok ? "ok" : "unreachable"}
        />
        <h3 className="truncate text-[13px] font-medium text-fg">{health.connectionName}</h3>
        <Badge variant="neutral" size="xs">
          {formatNumber(rows.length)} samples
        </Badge>
        {rows.length > PAGE_SIZE && (
          <button
            type="button"
            className="ml-auto text-[11px] text-accent hover:underline"
            onClick={() => setExpanded((e) => !e)}
          >
            {expanded ? `Show latest ${PAGE_SIZE}` : `Show all ${rows.length}`}
          </button>
        )}
      </div>
      <Table dense maxHeight={expanded ? 420 : undefined}>
        <thead>
          <tr>
            <Th>Time</Th>
            <Th align="right">Latency</Th>
            <Th align="right">Memory</Th>
            <Th align="right">Commands/s</Th>
            <Th align="right">CPU</Th>
            <Th align="right">Clients</Th>
          </tr>
        </thead>
        <tbody>
          {shown.length === 0 ? (
            <TableMessage colSpan={6}>
              No samples yet{health.ok ? "" : " — Redis is unreachable"}
            </TableMessage>
          ) : (
            shown.map((p) => (
              <tr key={p.t}>
                <Td num mono>
                  {formatDateTime(p.t)}
                </Td>
                <Td align="right" num>
                  {formatLatency(p.latencyMs)}
                </Td>
                <Td align="right" num>
                  {formatBytes(p.memoryBytes)}
                </Td>
                <Td align="right" num muted={p.commandsPerSec == null}>
                  {p.commandsPerSec == null ? <NoRate /> : formatRate(p.commandsPerSec, "")}
                </Td>
                <Td align="right" num muted={p.cpuCores == null}>
                  {p.cpuCores == null ? (
                    <NoRate />
                  ) : (
                    // Percent of one core reads at a glance; the raw cores
                    // stay one hover away for anyone sizing the box.
                    <Tooltip content={cpuTooltip(p.cpuCores)}>
                      <span className="cursor-help">{formatCpuPercent(p.cpuCores)}</span>
                    </Tooltip>
                  )}
                </Td>
                <Td align="right" num>
                  {formatNumber(p.connectedClients)}
                </Td>
              </tr>
            ))
          )}
        </tbody>
      </Table>
    </div>
  );
}

function NoRate() {
  return (
    <Tooltip content="No rate for this sample — it was the first one, or Redis had just restarted. Not zero.">
      <span className="cursor-help text-fg-subtle">—</span>
    </Tooltip>
  );
}
