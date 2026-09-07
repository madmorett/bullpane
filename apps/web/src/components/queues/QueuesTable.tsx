import { useMemo, type ReactNode } from "react";
import type { JobState } from "@bullmq-visualizer/shared";
import { Link, useNavigate } from "react-router-dom";
import { EyeOff, Pause, Play, Search } from "lucide-react";
import { cn } from "@/lib/cn";
import { routes } from "@/lib/routes";
import { formatNumber, formatPercent } from "@/lib/format";
import { STATE_COLORS } from "@/lib/stateColors";
import { entryKey, type QueueEntry } from "@/lib/groupQueues";
import { queueLandingState } from "@/lib/queueLanding";
import type { SortState } from "@/lib/useTableState";
import { SortableTable, type SortableColumn } from "@/components/SortableTable";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Sparkline } from "@/components/ui/Sparkline";
import { SuccessBar, windowLabel } from "./QueueCard";
import { SkewWarning, isSkewed, rateSourceHint } from "./RateSource";
import { HIDE_TOOLTIP } from "./hideQueue";

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
  /**
   * "Hide from the lists" from the row (operators). Reversible and non
   * destructive, so it fires immediately — no confirm dialog, an Undo toast.
   */
  onHide?: (entry: QueueEntry) => void;
  hidePendingKey?: string | null;
}

export function QueuesTable({ rows, showConnection, sort, onSort, message, messageClassName, onToggle, pendingKey, onHide, hidePendingKey }: QueuesTableProps) {
  const navigate = useNavigate();

  const columns = useMemo<SortableColumn<QueueEntry>[]>(() => {
    const cols: SortableColumn<QueueEntry>[] = [
      {
        key: "queue",
        header: "Queue",
        sortValue: (e) => e.queue.name,
        render: (e) => (
          <Link to={routes.queue(e.connection.id, e.queue.name, queueLandingState(e.queue.counts))} className="font-mono text-xs font-medium hover:underline" title={`${e.queue.prefix}:${e.queue.name}`}>
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
          const rates = e.queue.rates;
          const pct = rates?.successPct ?? null;
          // A skewed reading is dimmed and flagged, never hidden: the operator still
          // sees the number, plus why it probably lies (removeOnComplete pruning).
          const skewed = isSkewed(rates);
          return (
            <span className="inline-flex items-center justify-end gap-1.5" title={rateSourceHint(rates)}>
              <SuccessBar rates={rates} compact className="w-14" />
              <span className={cn("num w-14 text-right", skewed && "opacity-50", pct == null ? "text-fg-subtle" : pct < 90 ? "font-semibold text-state-failed" : "text-fg")}>{pct == null ? "–" : formatPercent(pct)}</span>
              <SkewWarning rates={rates} className="w-3" />
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
            {onHide && (
              <Button size="icon-xs" variant="ghost" loading={hidePendingKey === entryKey(e)} title={HIDE_TOOLTIP} aria-label={`Hide ${e.queue.name} from the lists`} onClick={() => onHide(e)}>
                <EyeOff />
              </Button>
            )}
          </span>
        ),
      },
    );
    return cols;
  }, [showConnection, onToggle, pendingKey, onHide, hidePendingKey, navigate, rows]);

  return <SortableTable columns={columns} rows={rows} rowKey={entryKey} sort={sort} onSort={onSort} onRowActivate={(e) => navigate(routes.queue(e.connection.id, e.queue.name, queueLandingState(e.queue.counts)))} message={message} messageClassName={messageClassName} className="min-w-[1100px]" />;
}

/**
 * A coluna de contagem de um estado. O número é um LINK para aquele estado da
 * fila: "failed 22" na tabela abre a aba failed, em vez de abrir a fila em
 * `waiting` e mostrar uma tabela vazia.
 *
 * `noRowClick` fica ligado para o clique no número não disputar com a ativação
 * da linha (que vai para o landing state). Um zero não vira link: não há nada
 * para ver, e um link para o vazio é a armadilha que estamos corrigindo.
 */
function count(key: string, header: string, get: (e: QueueEntry) => number, mutedWhenZero = false): SortableColumn<QueueEntry> {
  const color = (STATE_COLORS as Record<string, { textClass: string } | undefined>)[key]?.textClass;
  const state = key as JobState;
  return {
    key,
    header,
    align: "right",
    num: true,
    sortValue: get,
    noRowClick: true,
    render: (e) => {
      const v = get(e);
      const cls = cn(v > 0 ? color : "text-fg-subtle", key === "failed" && v > 0 && "font-semibold");
      if (v === 0) return <span className={cls}>{formatNumber(v)}</span>;
      return (
        <Link to={routes.queue(e.connection.id, e.queue.name, state)} className={cn(cls, "hover:underline")} title={`Open the ${header.toLowerCase()} jobs of ${e.queue.name}`}>
          {formatNumber(v)}
        </Link>
      );
    },
    muted: mutedWhenZero ? (e) => get(e) === 0 : undefined,
  };
}
