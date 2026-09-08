import { useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { Database, Plus } from "lucide-react";
import { routes } from "@/lib/routes";
import { formatNumber } from "@/lib/format";
import { groupQueues, matchesFilter, totals, type QueueEntry } from "@/lib/groupQueues";
import { splitByAttention } from "@/lib/queueAttention";
import { useTableState } from "@/lib/useTableState";
import { useAttentionThresholds, useConnectionOverviews, useFolders } from "@/api/hooks";
import { useAuth } from "@/auth/AuthProvider";
import { useEdition } from "@/edition/useEdition";
import { Page, PageHeader } from "@/components/layout/AppShell";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { QueueCardGrid, QueueCardSkeleton } from "@/components/queues/QueueCardGrid";
import { CollapsibleQueueGroups } from "@/components/queues/CollapsibleQueueGroups";
import { QueueAttentionSection } from "@/components/queues/QueueAttentionSection";
import { QueueTotalsStrip } from "@/components/queues/QueueTotalsStrip";
import { QueueFilterInput } from "@/components/queues/QueueFilterInput";
import { DEFAULT_QUEUE_SORT, QUEUE_TABLE_KEYS, QueuesTable } from "@/components/queues/QueuesTable";
import { RedisHealthStrip } from "@/components/health/RedisHealthStrip";
import { useHideQueueAnywhere } from "@/components/queues/hideQueue";

/**
 * How many connections before the page stops showing every queue as a card.
 * One or two connections is the shape the Overview was designed for and it
 * worked; the wall only appears when a fleet is connected.
 */
const CARD_WALL_LIMIT = 2;

export function OverviewPage() {
  const { isAdmin, isOperator } = useAuth();
  const { has } = useEdition();
  const { connections, entries, isLoading } = useConnectionOverviews();
  const thresholds = useAttentionThresholds();
  const foldersEnabled = has("folders");
  const folders = useFolders(foldersEnabled);
  const navigate = useNavigate();
  const { sort, setSort, filter, setFilter } = useTableState("overview", DEFAULT_QUEUE_SORT, QUEUE_TABLE_KEYS);

  const all = useMemo<QueueEntry[]>(
    () => entries.flatMap((e) => (e.result.data?.queues ?? []).map((q) => ({ connection: e.connection, queue: q }))),
    [entries],
  );
  // The filter still drives everything below it: cards, groups AND the table.
  const visible = useMemo(() => all.filter((e) => matchesFilter(e, filter)), [all, filter]);
  const sums = useMemo(() => totals(all), [all]);
  const queuesLoading = isLoading || entries.some((e) => e.result.isLoading);
  /**
   * Hidden queues across every connection. `all` already excludes them (the
   * server filters the list), so the strip sums only what is visible and states
   * the remainder instead of quietly absorbing it. The link goes to the one
   * connection when there is only one; otherwise there is nowhere honest to
   * point, so the number is text.
   */
  const hiddenCount = useMemo(() => entries.reduce((n, e) => n + (e.result.data?.hiddenCount ?? 0), 0), [entries]);
  /**
   * Connections whose SCAN has not completed a full cycle yet. On a Redis with
   * millions of keys that takes a few passes; queues with a live worker are
   * already listed, the rest arrive as the scan advances. Saying so beats letting
   * an incomplete list read as "these are all your queues".
   */
  const scanning = useMemo(
    () => entries.filter((e) => e.result.data?.discovery && !e.result.data.discovery.complete).map((e) => ({ name: e.connection.name, keys: e.result.data?.discovery?.totalKeys ?? null })),
    [entries],
  );
  const soleHiddenConnection = useMemo(() => {
    const withHidden = entries.filter((e) => (e.result.data?.hiddenCount ?? 0) > 0);
    return withHidden.length === 1 ? withHidden[0]!.connection.id : null;
  }, [entries]);

  // Hide from the overview too, where the connection varies per row. No confirm
  // dialog: it is reversible and the toast carries the Undo.
  const hiding = useHideQueueAnywhere();
  const onHide = isOperator ? (e: QueueEntry) => void hiding.hide(e.connection.id, e.queue.name) : undefined;

  const connectionCount = connections.data?.length ?? 0;
  /** the fleet layout: attention cards on top, the rest folded per connection */
  const dense = connectionCount > CARD_WALL_LIMIT;

  const split = useMemo(() => splitByAttention(visible, thresholds.data), [visible, thresholds.data]);
  const restSections = useMemo(
    () => groupQueues(split.rest, foldersEnabled ? folders.data : undefined),
    [split.rest, foldersEnabled, folders.data],
  );
  const allSections = useMemo(
    () => groupQueues(visible, foldersEnabled ? folders.data : undefined),
    [visible, foldersEnabled, folders.data],
  );

  if (!isLoading && connectionCount === 0) {
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

      <RedisHealthStrip className="mb-3" />

      {scanning.length > 0 && (
        <p className="mb-3 rounded-md border border-warning/30 bg-warning/10 px-3 py-2 text-xs text-fg-muted" role="status">
          Still discovering queues on {scanning.map((s) => `${s.name}${s.keys ? ` (${formatNumber(s.keys)} keys)` : ""}`).join(", ")}: the keyspace is large and the SCAN runs in bounded passes.
          Queues with a connected worker are listed already; the others appear as the scan completes.
        </p>
      )}

      <section className="space-y-3" aria-label="All queues">
        <QueueTotalsStrip
          totals={sums}
          hiddenCount={hiddenCount}
          onRevealHidden={soleHiddenConnection ? () => navigate(`${routes.connection(soleHiddenConnection)}#hidden-queues`) : undefined}
        >
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
          <>
            {/*
              Always first, at every fleet size. It used to appear only past
              CARD_WALL_LIMIT, which meant the single-connection install — the
              common one — had no place that answered "is anything wrong?".
              With one connection the flagged queues also stay in the grid below;
              that repetition is deliberate, the grid is the inventory and this
              is the triage.
            */}
            <QueueAttentionSection items={split.attention} hidden={split.hidden} showConnection={dense} filtered={!!filter} />
            {dense ? (
              <CollapsibleQueueGroups sections={restSections} showConnection defaultOpen={false} />
            ) : (
              <QueueCardGrid sections={allSections} showConnection onHide={onHide} />
            )}
          </>
        )}

        <div className="card overflow-hidden">
          <QueuesTable
            rows={visible}
            showConnection
            sort={sort}
            onSort={setSort}
            onHide={onHide}
            message={queuesLoading && all.length === 0 ? "Loading queues…" : filter ? "No queue matches the filter" : "No queues discovered yet"}
          />
        </div>
      </section>
    </Page>
  );
}
