import { useMemo, type ReactNode } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Pause, Play, Search } from "lucide-react";
import { cn } from "@/lib/cn";
import { routes } from "@/lib/routes";
import { formatNumber, formatPercent } from "@/lib/format";
import { STATE_COLORS } from "@/lib/stateColors";
import { entryKey, type QueueEntry } from "@/lib/groupQueues";
import type { SortState } from "@/lib/useTableState";
import { SortableTable, type SortableColumn } from "@/components/SortableTable";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Sparkline } from "@/components/ui/Sparkline";
import { SuccessBar, windowLabel } from "./QueueCard";

export const QUEUE_TABLE_KEYS = ["queue", "connection", "waiting", "active", "completed", "failed", "delayed", "prioritized", "waiting-children", "success", "paused", "groups", "trend", "actions"] as const;
export const DEFAULT_QUEUE_SORT: SortState = { key: "failed", dir: "desc" };

export interface QueuesTableProps {
  rows: QueueEntry[];
  showConnection?: boolean;
  sort: SortState;
  onSort: (s: SortState) => void;
  message?: ReactNode;
  messageClassName?: string;
  /** pause / resume from the row (connection page, operators) */
  onToggle?: (entry: QueueEntry) => void;
  pendingKey?: string | null;
}

export function QueuesTable({ rows, showConnection, sort, onSort, message, messageClassName, onToggle, pendingKey }: QueuesTableProps) {
  const navigate = useNavigate();

  const columns = useMemo<SortableColumn<QueueEntry>[]>(() => {
    const cols: SortableColumn<QueueEntry>[] = [
      {
        key: "queue",
        header: "Queue",
        sortValue: (e) => e.queue.name,
        render: (e) => (
          <Link to={routes.queue(e.connection.id, e.queue.name)} className="font-mono text-xs font-medium hover:underline" title={`${e.queue.prefix}:${e.queue.name}`}>
            {e.queue.name}
          </Link>
        ),
        className: "max-w-72 truncate",
      },
    ];
    if (showConnection) cols.push({ key: "connection", header: "Connection", sortValue: (e) => e.connection.name, render: (e) => e.connection.name, muted: true, className: "max-w-48 truncate" });
    cols.push(
      count("waiting", "Waiting", (e) => e.queue.counts.waiting),
      count("active", "Active", (e) => e.queue.counts.active),
      count("completed", "Completed", (e) => e.queue.counts.completed, true),
      count("failed", "Failed", (e) => e.queue.counts.failed),
      count("delayed", "Delayed", (e) => e.queue.counts.delayed, true),
      count("prioritized", "Prioritized", (e) => e.queue.counts.prioritized, true),
      count("waiting-children", "Waiting-children", (e) => e.queue.counts["waiting-children"], true),
      {
        key: "success",
        header: `Success % (${windowLabel(rows[0]?.queue.rates?.windowMinutes)})`,
        align: "right",
        num: true,
        sortValue: (e) => e.queue.rates?.successPct ?? null,
        render: (e) => {
          const pct = e.queue.rates?.successPct ?? null;
          return (
            <span className="inline-flex items-center justify-end gap-2">
              <SuccessBar rates={e.queue.rates} compact className="w-14" />
              <span className={cn("num w-14 text-right", pct == null ? "text-fg-subtle" : pct < 90 ? "font-semibold text-state-failed" : "text-fg")}>{pct == null ? "–" : formatPercent(pct)}</span>
            </span>
          );
        },
      },
      {
        key: "paused",
        header: "Paused",
        sortValue: (e) => e.queue.isPaused,
        render: (e) =>
          e.queue.isPaused ? (
            <Badge variant="warning" size="xs" className="tracking-wider">
              PAUSED
            </Badge>
          ) : (
            <span className="text-fg-subtle">–</span>
          ),
      },
      {
        key: "groups",
        header: "Groups",
        align: "right",
        num: true,
        sortValue: (e) => (e.queue.isPro ? e.queue.groupsCount : null),
        render: (e) =>
          e.queue.isPro ? (
            <Link to={routes.groups(e.connection.id, e.queue.name)} className="inline-flex items-center gap-1.5 hover:underline" title="BullMQ Pro groups">
              <Badge variant="pro" size="xs" className="tracking-wider">
                PRO
              </Badge>
              {formatNumber(e.queue.groupsCount)}
            </Link>
          ) : (
            <span className="text-fg-subtle">–</span>
          ),
      },
      {
        key: "trend",
        header: "Trend",
        sortValue: (e) => {
          const m = e.queue.metrics?.completed;
          return m && m.length ? m.reduce((a, b) => a + b, 0) : null;
        },
        render: (e) => (
          <span style={{ color: STATE_COLORS.completed.fg }}>
            <Sparkline values={e.queue.metrics?.completed} width={80} height={18} title="Completed per minute" />
          </span>
        ),
      },
      {
        key: "actions",
        header: <span className="sr-only">Actions</span>,
        align: "right",
        noRowClick: true,
        render: (e) => (
          <span className="inline-flex items-center justify-end gap-0.5">
            <Button size="icon-xs" variant="ghost" title="Search jobs" aria-label={`Search jobs in ${e.queue.name}`} onClick={() => navigate(routes.queueSearch(e.connection.id, e.queue.name))}>
              <Search />
            </Button>
            {onToggle && (
              <Button size="icon-xs" variant="ghost" loading={pendingKey === entryKey(e)} title={e.queue.isPaused ? "Resume queue" : "Pause queue"} aria-label={e.queue.isPaused ? "Resume queue" : "Pause queue"} onClick={() => onToggle(e)}>
                {e.queue.isPaused ? <Play /> : <Pause />}
              </Button>
            )}
          </span>
        ),
      },
    );
    return cols;
  }, [showConnection, onToggle, pendingKey, navigate, rows]);

  return <SortableTable columns={columns} rows={rows} rowKey={entryKey} sort={sort} onSort={onSort} onRowActivate={(e) => navigate(routes.queue(e.connection.id, e.queue.name))} message={message} messageClassName={messageClassName} className="min-w-[1100px]" />;
}

function count(key: string, header: string, get: (e: QueueEntry) => number, mutedWhenZero = false): SortableColumn<QueueEntry> {
  const color = (STATE_COLORS as Record<string, { textClass: string } | undefined>)[key]?.textClass;
  return {
    key,
    header,
    align: "right",
    num: true,
    sortValue: get,
    render: (e) => {
      const v = get(e);
      return <span className={cn(v > 0 ? color : "text-fg-subtle", key === "failed" && v > 0 && "font-semibold")}>{formatNumber(v)}</span>;
    },
    muted: mutedWhenZero ? (e) => get(e) === 0 : undefined,
  };
}
