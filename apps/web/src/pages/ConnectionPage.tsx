import { useMemo } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { Database, RefreshCw, Settings } from "lucide-react";
import { routes } from "@/lib/routes";
import { formatBytes, formatNumber, formatUptime } from "@/lib/format";
import { entryKey, groupQueues, matchesFilter, totals, type QueueEntry } from "@/lib/groupQueues";
import { useTableState } from "@/lib/useTableState";
import { useConnectionOverview, useConnections, useFolders, useQueueToggle, useRefreshQueues } from "@/api/hooks";
import { errorMessage } from "@/api/client";
import { useAuth } from "@/auth/AuthProvider";
import { useEdition } from "@/edition/useEdition";
import { toast } from "@/components/Toast";
import { Page, PageHeader } from "@/components/layout/AppShell";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { Spinner } from "@/components/ui/Spinner";
import { ConnectionStatusDot } from "@/components/ConnectionStatusDot";
import { QueueCardGrid, QueueCardSkeleton } from "@/components/queues/QueueCardGrid";
import { QueueTotalsStrip } from "@/components/queues/QueueTotalsStrip";
import { QueueFilterInput } from "@/components/queues/QueueFilterInput";
import { DEFAULT_QUEUE_SORT, QUEUE_TABLE_KEYS, QueuesTable } from "@/components/queues/QueuesTable";

export function ConnectionPage() {
  const { connectionId = "" } = useParams();
  const { isOperator, isAdmin } = useAuth();
  const { has } = useEdition();
  const connections = useConnections();
  const connection = connections.data?.find((c) => c.id === connectionId);
  const overview = useConnectionOverview(connectionId);
  const refresh = useRefreshQueues(connectionId);
  const toggle = useQueueToggle(connectionId);
  const foldersEnabled = has("folders");
  const folders = useFolders(foldersEnabled);
  const navigate = useNavigate();
  const { sort, setSort, filter, setFilter } = useTableState(`connection.${connectionId}`, DEFAULT_QUEUE_SORT, QUEUE_TABLE_KEYS);

  const all = useMemo<QueueEntry[]>(() => (connection ? (overview.data?.queues ?? []).map((queue) => ({ connection, queue })) : []), [connection, overview.data]);
  const visible = useMemo(() => all.filter((e) => matchesFilter(e, filter)), [all, filter]);
  const sections = useMemo(() => groupQueues(visible, foldersEnabled ? folders.data : undefined), [visible, foldersEnabled, folders.data]);
  const sums = useMemo(() => totals(all), [all]);

  if (connections.isSuccess && !connection) {
    return (
      <Page>
        <EmptyState icon={<Database />} title="Connection not found" description="It may have been removed." action={<Link to="/" className="text-accent hover:underline">Back to overview</Link>} />
      </Page>
    );
  }

  const info = overview.data?.info;
  const status = overview.data?.status ?? connection?.status;

  const onToggle = isOperator
    ? (e: QueueEntry) =>
        toggle.mutate(
          { queue: e.queue.name, action: e.queue.isPaused ? "resume" : "pause" },
          { onSuccess: () => toast.success(`${e.queue.name} ${e.queue.isPaused ? "resumed" : "paused"}`), onError: (err) => toast.error(errorMessage(err)) },
        )
    : undefined;
  const pendingKey = toggle.isPending && toggle.variables ? `${connectionId}/${toggle.variables.queue}` : null;

  return (
    <Page wide>
      <PageHeader
        title={
          <span className="flex items-center gap-2">
            {connection?.name ?? connectionId}
            <ConnectionStatusDot status={status} pulse withLabel />
          </span>
        }
        description={
          connection && (
            <span className="font-mono">
              {connection.url} · prefix <span className="text-fg">{connection.prefix}</span>
              {connection.cluster && " · cluster"}
              {connection.queueFilter && ` · filter ${connection.queueFilter}`}
            </span>
          )
        }
        actions={
          <>
            <Button
              size="sm"
              variant="secondary"
              leftIcon={<RefreshCw />}
              loading={refresh.isPending}
              onClick={() => refresh.mutate(undefined, { onSuccess: () => toast.success("Queue list refreshed"), onError: (e) => toast.error(errorMessage(e)) })}
              title="Force queue rediscovery (bypasses the 30 s cache)"
            >
              Rediscover
            </Button>
            {isAdmin && (
              <Button size="sm" variant="ghost" leftIcon={<Settings />} onClick={() => navigate(`${routes.settings("connections")}?edit=${encodeURIComponent(connectionId)}`)}>
                Edit
              </Button>
            )}
          </>
        }
      />

      {status && !status.ok && (
        <div className="mb-4 rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-xs text-danger" role="alert">
          Redis unreachable: {status.error ?? "unknown error"}
        </div>
      )}

      <div className="card mb-4 grid grid-cols-2 gap-px overflow-hidden bg-border sm:grid-cols-4 lg:grid-cols-8">
        <Info label="Redis" value={info?.redisVersion} />
        <Info label="Mode" value={info?.mode} />
        <Info label="Uptime" value={info ? formatUptime(info.uptimeSeconds) : undefined} />
        <Info label="Clients" value={info ? formatNumber(info.connectedClients) : undefined} />
        <Info label="Memory" value={info ? `${formatBytes(info.usedMemoryBytes)}${info.maxMemoryBytes ? ` / ${formatBytes(info.maxMemoryBytes)}` : ""}` : undefined} />
        <Info label="Keys" value={info ? (info.totalKeys != null ? formatNumber(info.totalKeys) : "–") : undefined} />
        <Info label="Ops / s" value={info ? (info.opsPerSec != null ? formatNumber(info.opsPerSec) : "–") : undefined} />
        <Info label="Latency" value={status ? (status.latencyMs != null ? `${status.latencyMs} ms` : "–") : undefined} />
      </div>

      <section className="space-y-3" aria-label="Queues">
        <QueueTotalsStrip totals={sums} title="Queues">
          <QueueFilterInput value={filter} onChange={setFilter} aria-label="Filter queues" />
          <span className="num whitespace-nowrap text-xs text-fg-subtle">
            {visible.length} of {all.length}
          </span>
        </QueueTotalsStrip>

        {overview.isLoading ? (
          <QueueCardSkeleton />
        ) : visible.length > 0 ? (
          <QueueCardGrid sections={sections} hideSingleHeader />
        ) : null}

        <div className="card overflow-hidden">
          <QueuesTable
            rows={visible}
            sort={sort}
            onSort={setSort}
            onToggle={onToggle}
            pendingKey={pendingKey}
            message={
              overview.isLoading ? (
                <Spinner label="Loading queues…" />
              ) : overview.isError && !overview.data ? (
                errorMessage(overview.error)
              ) : filter ? (
                "No queue matches the filter"
              ) : (
                "No queues discovered. Check the prefix and queue filter, then rediscover."
              )
            }
            messageClassName={overview.isError && !overview.data ? "text-danger" : undefined}
          />
        </div>
      </section>
    </Page>
  );
}

function Info({ label, value }: { label: string; value: React.ReactNode | undefined }) {
  return (
    <div className="bg-surface px-3 py-2">
      <div className="text-[10px] tracking-wide text-fg-subtle uppercase">{label}</div>
      <div className="num truncate text-[13px] font-medium text-fg">{value === undefined ? <span className="skeleton inline-block h-3 w-12" /> : value}</div>
    </div>
  );
}

// re-exported for tests / future callers that need the same key shape as the table
export { entryKey };
