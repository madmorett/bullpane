import { useMemo } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Database, Plus, Server } from "lucide-react";
import { cn } from "@/lib/cn";
import { routes } from "@/lib/routes";
import { formatBytes, formatCompact, formatNumber } from "@/lib/format";
import { groupQueues, matchesFilter, totals, type QueueEntry } from "@/lib/groupQueues";
import { useTableState } from "@/lib/useTableState";
import { STATE_COLORS } from "@/lib/stateColors";
import { useConnectionOverviews, useFolders, type ConnectionOverviewEntry } from "@/api/hooks";
import { useAuth } from "@/auth/AuthProvider";
import { useEdition } from "@/edition/useEdition";
import { Page, PageHeader } from "@/components/layout/AppShell";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { Badge } from "@/components/ui/Badge";
import { Skeleton } from "@/components/ui/Spinner";
import { ConnectionStatusDot } from "@/components/ConnectionStatusDot";
import { RelativeTime } from "@/components/ui/RelativeTime";
import { QueueCardGrid, QueueCardSkeleton } from "@/components/queues/QueueCardGrid";
import { QueueTotalsStrip } from "@/components/queues/QueueTotalsStrip";
import { QueueFilterInput } from "@/components/queues/QueueFilterInput";
import { DEFAULT_QUEUE_SORT, QUEUE_TABLE_KEYS, QueuesTable } from "@/components/queues/QueuesTable";
import { RedisHealthPanel } from "@/components/health/RedisHealthPanel";

export function OverviewPage() {
  const { isAdmin } = useAuth();
  const { has } = useEdition();
  const { connections, entries, isLoading } = useConnectionOverviews();
  const foldersEnabled = has("folders");
  const folders = useFolders(foldersEnabled);
  const navigate = useNavigate();
  const { sort, setSort, filter, setFilter } = useTableState("overview", DEFAULT_QUEUE_SORT, QUEUE_TABLE_KEYS);

  const all = useMemo<QueueEntry[]>(() => entries.flatMap((e) => (e.result.data?.queues ?? []).map((q) => ({ connection: e.connection, queue: q }))), [entries]);
  const visible = useMemo(() => all.filter((e) => matchesFilter(e, filter)), [all, filter]);
  const sections = useMemo(() => groupQueues(visible, foldersEnabled ? folders.data : undefined), [visible, foldersEnabled, folders.data]);
  const sums = useMemo(() => totals(all), [all]);
  const queuesLoading = isLoading || entries.some((e) => e.result.isLoading);

  if (!isLoading && (connections.data?.length ?? 0) === 0) {
    return (
      <Page>
        <EmptyState
          icon={<Database />}
          title="No Redis connections yet"
          description={
            isAdmin
              ? "Point the dashboard at a Redis that runs BullMQ. Queues are discovered automatically from the key prefix."
              : "An administrator needs to add a Redis connection before queues show up here."
          }
          action={
            isAdmin && (
              <Button variant="primary" leftIcon={<Plus />} onClick={() => navigate(`${routes.settings("connections")}?new=1`)}>
                Add connection
              </Button>
            )
          }
        />
      </Page>
    );
  }

  return (
    <Page wide>
      <PageHeader title="Overview" description="Every connection and queue at a glance. Refreshes every 5 seconds." />

      <RedisHealthPanel className="mb-6" />

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
        {isLoading && [0, 1, 2].map((i) => <div key={i} className="card h-36 animate-pulse" />)}
        {entries.map((e) => (
          <ConnectionCard key={e.connection.id} entry={e} />
        ))}
      </div>

      <section className="mt-6 space-y-3" aria-label="All queues">
        <QueueTotalsStrip totals={sums}>
          <QueueFilterInput value={filter} onChange={setFilter} aria-label="Filter queues by name or connection" />
          <span className="num whitespace-nowrap text-xs text-fg-subtle">
            {visible.length} of {all.length}
          </span>
        </QueueTotalsStrip>

        {queuesLoading && all.length === 0 ? (
          <QueueCardSkeleton />
        ) : visible.length === 0 ? (
          <p className="py-6 text-center text-xs text-fg-subtle">{filter ? "No queue matches the filter" : "No queues discovered yet"}</p>
        ) : (
          <QueueCardGrid sections={sections} showConnection />
        )}

        <div className="card overflow-hidden">
          <QueuesTable
            rows={visible}
            showConnection
            sort={sort}
            onSort={setSort}
            message={queuesLoading && all.length === 0 ? "Loading queues…" : filter ? "No queue matches the filter" : "No queues discovered yet"}
          />
        </div>
      </section>
    </Page>
  );
}

function ConnectionCard({ entry }: { entry: ConnectionOverviewEntry }) {
  const { connection, result } = entry;
  const data = result.data;
  const status = data?.status ?? connection.status;
  const queues = data?.queues ?? [];
  const sums = queues.reduce(
    (acc, q) => {
      acc.waiting += q.counts.waiting + q.counts.prioritized;
      acc.active += q.counts.active;
      acc.failed += q.counts.failed;
      return acc;
    },
    { waiting: 0, active: 0, failed: 0 },
  );
  const down = status && !status.ok;

  return (
    <Link to={routes.connection(connection.id)} className={cn("card flex flex-col gap-3 p-4 transition-colors hover:border-border-strong", down && "border-danger/40")}>
      <div className="flex items-start gap-2">
        <Server className="mt-0.5 size-4 shrink-0 text-fg-subtle" aria-hidden />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h3 className="truncate text-sm font-semibold">{connection.name}</h3>
            <ConnectionStatusDot status={status} pulse />
          </div>
          <p className="truncate font-mono text-[11px] text-fg-subtle">{connection.url}</p>
        </div>
        {connection.cluster && (
          <Badge variant="outline" size="xs">
            cluster
          </Badge>
        )}
      </div>

      {down ? (
        <p className="rounded-md bg-danger/10 px-2 py-1.5 text-xs text-danger">{status?.error ?? "Connection failing"}</p>
      ) : (
        <dl className="grid grid-cols-4 gap-2 text-xs">
          <Stat label="Redis" value={data ? data.info.redisVersion : <Skeleton />} />
          <Stat label="Memory" value={data ? formatBytes(data.info.usedMemoryBytes) : <Skeleton />} />
          <Stat label="Clients" value={data ? formatNumber(data.info.connectedClients) : <Skeleton />} />
          <Stat label="Queues" value={data ? formatNumber(queues.length) : <Skeleton />} />
        </dl>
      )}

      <div className="flex items-center gap-4 border-t border-border pt-3 text-xs">
        <Total label="waiting" value={sums.waiting} tone={STATE_COLORS.waiting.textClass} />
        <Total label="active" value={sums.active} tone={STATE_COLORS.active.textClass} />
        <Total label="failed" value={sums.failed} tone={sums.failed > 0 ? STATE_COLORS.failed.textClass : "text-fg-muted"} />
        {status?.checkedAt && (
          <span className="ml-auto text-[11px] text-fg-subtle">
            checked <RelativeTime value={status.checkedAt} />
          </span>
        )}
      </div>
    </Link>
  );
}

function Stat({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-[10px] tracking-wide text-fg-subtle uppercase">{label}</dt>
      <dd className="num truncate font-medium text-fg">{value}</dd>
    </div>
  );
}

function Total({ label, value, tone }: { label: string; value: number; tone: string }) {
  return (
    <span className="flex items-baseline gap-1">
      <span className={cn("num text-sm font-semibold", tone)}>{formatCompact(value)}</span>
      <span className="text-fg-subtle">{label}</span>
    </span>
  );
}
