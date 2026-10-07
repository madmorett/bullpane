import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { ChevronLeft, FastForward, Info, Layers, Pause, Play, Trash2 } from "lucide-react";
import { GROUP_STATUSES, type GroupStatus, type GroupSummary, type GroupsByStatus } from "@bullpane/shared";
import { routes } from "@/lib/routes";
import { cn } from "@/lib/cn";
import { formatDuration, formatNumber } from "@/lib/format";
import { useNow } from "@/lib/useNow";
import { useGroupAction, useGroupJobs, useGroups, useJobAction, useQueue, type GroupActionKind, type JobActionKind } from "@/api/hooks";
import { errorMessage } from "@/api/client";
import { useAuth } from "@/auth/AuthProvider";
import { toast } from "@/components/Toast";
import { Page, PageHeader } from "@/components/layout/AppShell";
import { Badge, type BadgeVariant } from "@/components/ui/Badge";
import { Tooltip } from "@/components/ui/Tooltip";
import { Table, TableMessage, Td, Th, Tr } from "@/components/ui/Table";
import { Spinner } from "@/components/ui/Spinner";
import { Pagination } from "@/components/Pagination";
import { JobsTable } from "@/components/JobsTable";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { Button } from "@/components/ui/Button";
import { PromoteMatchingDialog } from "@/components/PromoteMatchingDialog";
import { useDelayedGroupCounts } from "./useDelayedGroupCounts";
import { useJobSelection, type JobSelection } from "@/lib/useJobSelection";
import { delayedOnlyGroups, pageOfRows } from "@/lib/groupRows";

const STATUS_VARIANT: Record<GroupStatus, BadgeVariant> = {
  waiting: "info",
  limited: "violet",
  maxed: "danger",
  paused: "warning",
};

const STATUS_HINT: Record<GroupStatus, string> = {
  waiting: "In rotation: the next worker fetch may take a job from this group.",
  limited: "Hit its rate limit. Pro parks the group until the window resets.",
  maxed: "Every concurrency slot of the group is busy. Frees up when one of its jobs finishes.",
  paused: "Paused with queue.pauseGroup(). Jobs keep arriving, none are processed.",
};

const WORKER_DEFAULT_HINT = "No per-group override in Redis. The worker's own group option applies (a worker option, not stored in Redis).";

export function GroupsPage() {
  const { connectionId = "", queue = "" } = useParams();
  const navigate = useNavigate();
  const { isOperator, isAdmin } = useAuth();
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const summary = useQueue(connectionId, queue);
  const groups = useGroups(connectionId, queue, { page, pageSize });
  const delayed = useDelayedGroupCounts(connectionId, queue, (summary.data?.counts.delayed ?? 0) > 0);
  const groupAction = useGroupAction(connectionId, queue);
  /** groups a dialog acts on: one row's, or the selection's */
  const [promoteTargets, setPromoteTargets] = useState<string[] | null>(null);
  const [drainTargets, setDrainTargets] = useState<string[] | null>(null);
  const [bulkBusy, setBulkBusy] = useState(false);
  const now = useNow(1000);
  const proApi = groups.data?.bullmqProApi ?? false;
  const showActions = isOperator;
  const cols = 7 + (showActions ? 2 : 0);

  // Groups only the delayed scan sees ("delayed only"): see lib/groupRows.ts. The
  // indexed rows are polled and the scan is older, so a group on screen as indexed
  // is never listed again as delayed only.
  const onScreen = useMemo(() => new Set(groups.data?.groups.map((g) => g.id) ?? []), [groups.data]);
  const delayedOnly = useMemo(() => delayedOnlyGroups(delayed.counts, onScreen), [delayed.counts, onScreen]);
  const indexedTotal = groups.data?.total ?? 0;
  const { delayedOnly: delayedOnlyPage, lastPage } = pageOfRows(delayedOnly, { indexedTotal, page, pageSize });
  // Promoting or pausing shrinks the list: never leave the operator past its end.
  useEffect(() => {
    if (groups.data && !delayed.loading && page > lastPage) setPage(lastPage);
  }, [groups.data, delayed.loading, page, lastPage]);

  // Selection by group id, like the jobs table (lib/useJobSelection.ts): rows move on
  // every poll, an index would point at another group.
  const visibleIds = useMemo(() => [...(groups.data?.groups.map((g) => g.id) ?? []), ...delayedOnlyPage.map((g) => g.id)], [groups.data, delayedOnlyPage]);
  const selection = useJobSelection(visibleIds);

  /**
   * One group action on one or many groups, GROUP_ACTION_CONCURRENCY at a time (each is
   * its own audited call). Successes leave the selection; failures stay selected.
   */
  const runGroups = async (groupIds: string[], action: GroupActionKind) => {
    setBulkBusy(true);
    const ok: string[] = [];
    const failed: string[] = [];
    let firstError: unknown = null;
    for (let i = 0; i < groupIds.length; i += GROUP_ACTION_CONCURRENCY) {
      await Promise.all(
        groupIds.slice(i, i + GROUP_ACTION_CONCURRENCY).map((groupId) =>
          groupAction.mutateAsync({ groupId, action }).then(
            () => ok.push(groupId),
            (e) => {
              failed.push(groupId);
              firstError ??= e;
            },
          ),
        ),
      );
    }
    setBulkBusy(false);
    setDrainTargets(null);
    selection.deselect(ok);
    delayed.refetch();
    const verb = action === "pause" ? "paused" : action === "resume" ? "resumed" : "drained";
    const what = groupIds.length === 1 ? `Group ${groupIds[0]}` : `${formatNumber(ok.length)} groups`;
    if (failed.length === 0) toast.success(`${what} ${verb}`);
    else toast.error(`${groupIds.length === 1 ? what : `${formatNumber(ok.length)} ${verb} · ${formatNumber(failed.length)} failed`}: ${errorMessage(firstError)}`);
  };
  const actionsFor = (groupId: string, opts: { paused: boolean; waiting: number; delayed: number | null }) =>
    showActions ? (
      <GroupActions
        proApi={proApi}
        busy={bulkBusy}
        paused={opts.paused}
        canPromote={opts.delayed !== 0}
        canDrain={isAdmin && opts.waiting > 0}
        onPromote={() => setPromoteTargets([groupId])}
        onToggle={() => void runGroups([groupId], opts.paused ? "resume" : "pause")}
        onDrain={() => setDrainTargets([groupId])}
      />
    ) : null;
  const delayedCell = (groupId: string) => {
    const c = delayed.counts.get(groupId);
    if (delayed.loading) return <span className="text-fg-subtle">…</span>;
    if (!c) return <span className="text-fg-subtle">{delayed.complete ? "0" : "–"}</span>;
    return (
      <Link to={routes.queueGroup(connectionId, queue, groupId, "delayed")} className="text-accent hover:underline" title="List this group's delayed jobs" onClick={(e) => e.stopPropagation()}>
        {formatNumber(c.delayed)}
        {!delayed.complete && "+"}
      </Link>
    );
  };

  return (
    <Page wide>
      <PageHeader
        title={
          <span className="flex items-center gap-2">
            <Link to={routes.queue(connectionId, queue)} className="text-fg-muted hover:text-fg">
              {queue}
            </Link>
            <span className="text-fg-subtle">/</span>
            Groups
            <Badge variant="pro">BullMQ Pro</Badge>
          </span>
        }
        description="Groups partition a queue for fairness, with their own concurrency and rate limit."
      />

      {groups.data && (
        <StatusStrip
          byStatus={groups.data.byStatus}
          total={groups.data.total}
          delayedOnly={delayedOnly.length}
          delayedScan={(summary.data?.counts.delayed ?? 0) > 0 ? delayed : null}
        />
      )}
      {groups.data && !proApi && <ProApiNotice />}
      {showActions && selection.selectedIds.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 rounded-md border border-accent/40 bg-accent/5 px-3 py-2 text-xs" role="region" aria-label="Selected groups">
          <span className="font-medium text-fg">
            {formatNumber(selection.selectedIds.length)} {selection.selectedIds.length === 1 ? "group" : "groups"} selected
          </span>
          {selection.offPageCount > 0 && <span className="text-fg-subtle">({formatNumber(selection.offPageCount)} not on this page)</span>}
          <span className="ml-auto flex flex-wrap items-center gap-2">
            <Button size="xs" variant="secondary" leftIcon={<FastForward />} disabled={!proApi || bulkBusy} title={proApi ? undefined : PRO_API_HINT} onClick={() => setPromoteTargets(selection.selectedIds)}>
              Promote all delayed
            </Button>
            <Button size="xs" variant="secondary" leftIcon={<Pause />} disabled={!proApi || bulkBusy} title={proApi ? undefined : PRO_API_HINT} onClick={() => void runGroups(selection.selectedIds, "pause")}>
              Pause
            </Button>
            <Button size="xs" variant="secondary" leftIcon={<Play />} disabled={!proApi || bulkBusy} title={proApi ? undefined : PRO_API_HINT} onClick={() => void runGroups(selection.selectedIds, "resume")}>
              Resume
            </Button>
            {isAdmin && (
              <Button size="xs" variant="danger" leftIcon={<Trash2 />} disabled={!proApi || bulkBusy} title={proApi ? undefined : PRO_API_HINT} onClick={() => setDrainTargets(selection.selectedIds)}>
                Drain
              </Button>
            )}
            <Button size="xs" variant="ghost" onClick={selection.clear}>
              Clear
            </Button>
          </span>
        </div>
      )}

      <div className="card overflow-hidden">
        <Table>
          <thead>
            <tr>
              {showActions && (
                <Th className="w-8">
                  <input
                    type="checkbox"
                    className="size-3.5 cursor-pointer align-middle accent-[var(--accent)]"
                    aria-label={selection.allVisibleSelected ? "Clear selection on this page" : "Select every group on this page"}
                    checked={selection.allVisibleSelected}
                    ref={(el) => {
                      if (el) el.indeterminate = !selection.allVisibleSelected && selection.visibleSelectedCount > 0;
                    }}
                    disabled={visibleIds.length === 0}
                    onChange={selection.toggleAllVisible}
                  />
                </Th>
              )}
              <Th>Group</Th>
              <Th>Status</Th>
              <Th align="right">Waiting</Th>
              <Th align="right">Delayed</Th>
              <Th align="right">Active / concurrency</Th>
              <Th align="right">Rate limit</Th>
              <Th align="right">Next</Th>
              {showActions && <Th align="right">Actions</Th>}
            </tr>
          </thead>
          <tbody>
            {groups.isLoading && (
              <TableMessage colSpan={cols}>
                <Spinner label="Loading groups…" />
              </TableMessage>
            )}
            {groups.isError && !groups.data && (
              <TableMessage colSpan={cols} className="text-danger">
                {errorMessage(groups.error)}
              </TableMessage>
            )}
            {groups.data && groups.data.groups.length === 0 && delayedOnly.length === 0 && !delayed.loading && (
              <TableMessage colSpan={cols}>No groups with jobs right now. Add jobs with opts.group.id to see them here.</TableMessage>
            )}
            {groups.data?.groups.map((g) => (
              <GroupRow
                key={g.id}
                g={g}
                now={now}
                onOpen={() => navigate(routes.group(connectionId, queue, g.id))}
                href={routes.group(connectionId, queue, g.id)}
                delayed={delayedCell(g.id)}
                select={showActions ? <SelectCell id={g.id} selection={selection} /> : null}
                actions={actionsFor(g.id, { paused: g.status === "paused", waiting: g.waiting, delayed: delayed.counts.get(g.id)?.delayed ?? (delayed.complete ? 0 : null) })}
              />
            ))}
            {delayedOnlyPage.map((g) => (
                <DelayedOnlyRow
                  key={g.id}
                  id={g.id}
                  nextRunAt={g.nextRunAt}
                  now={now}
                  onOpen={() => navigate(routes.queueGroup(connectionId, queue, g.id, "delayed"))}
                  href={routes.group(connectionId, queue, g.id)}
                  delayed={delayedCell(g.id)}
                  select={showActions ? <SelectCell id={g.id} selection={selection} /> : null}
                  actions={actionsFor(g.id, { paused: false, waiting: 0, delayed: g.delayed })}
                />
              ))}
          </tbody>
        </Table>
        <div className="border-t border-border px-3 py-2">
          <Pagination
            page={page}
            pageSize={pageSize}
            total={indexedTotal + delayedOnly.length}
            count={(groups.data?.groups.length ?? 0) + delayedOnlyPage.length}
            onPage={setPage}
            onPageSize={(s) => (setPageSize(s), setPage(1))}
          />
        </div>
      </div>

      {promoteTargets && (
        <PromoteMatchingDialog
          open
          onClose={({ ran }) => {
            // a cancel keeps the selection; once the action ran, those groups are done
            if (ran) {
              selection.deselect(promoteTargets);
              delayed.refetch();
            }
            setPromoteTargets(null);
          }}
          connectionId={connectionId}
          queue={queue}
          matches={promoteTargets.map((groupId) => ({ groupId }))}
        />
      )}
      <ConfirmDialog
        open={drainTargets !== null}
        onClose={() => setDrainTargets(null)}
        title={drainTargets && drainTargets.length > 1 ? `Drain ${formatNumber(drainTargets.length)} groups` : "Drain group"}
        description={`Remove every waiting job of ${
          drainTargets && drainTargets.length > 1 ? `these ${formatNumber(drainTargets.length)} groups` : `group ${drainTargets?.[0] ?? ""}`
        } in ${queue} (BullMQ Pro's deleteGroup)? Delayed jobs stay in the queue's delayed state. This cannot be undone.`}
        confirmText="Drain"
        danger
        loading={bulkBusy}
        onConfirm={() => drainTargets && runGroups(drainTargets, "drain")}
      />
    </Page>
  );
}

/** Group actions run this many at a time when several groups are selected. */
const GROUP_ACTION_CONCURRENCY = 4;
const PRO_API_HINT = "Needs BullMQ Pro's package installed next to Bullpane";

/** The row's checkbox; Shift+click selects a range, like the jobs table. Clicks do not open the row. */
function SelectCell({ id, selection }: { id: string; selection: JobSelection }) {
  return (
    <Td className="w-8" onClick={(e) => e.stopPropagation()}>
      <input
        type="checkbox"
        className="size-3.5 cursor-pointer align-middle accent-[var(--accent)]"
        aria-label={`Select group ${id}`}
        checked={selection.has(id)}
        onChange={() => undefined}
        onClick={(e) => (e.shiftKey ? selection.toggleRange(id) : selection.toggle(id))}
      />
    </Td>
  );
}

/** Per-row group actions. Clicks do not reach the row, which opens the group. */
function GroupActions(props: {
  proApi: boolean;
  busy: boolean;
  paused: boolean;
  canPromote: boolean;
  canDrain: boolean;
  onPromote: () => void;
  onToggle: () => void;
  onDrain: () => void;
}) {
  const hint = props.proApi ? undefined : "Needs BullMQ Pro's package installed next to Bullpane";
  return (
    <span className="inline-flex items-center justify-end gap-1" onClick={(e) => e.stopPropagation()}>
      {props.canPromote && (
        <Button size="icon-xs" variant="ghost" title={hint ?? "Promote all delayed jobs of this group"} aria-label="Promote all delayed jobs" disabled={!props.proApi} onClick={props.onPromote}>
          <FastForward />
        </Button>
      )}
      <Button
        size="icon-xs"
        variant="ghost"
        title={hint ?? (props.paused ? "Resume group" : "Pause group")}
        aria-label={props.paused ? "Resume group" : "Pause group"}
        disabled={!props.proApi || props.busy}
        onClick={props.onToggle}
      >
        {props.paused ? <Play /> : <Pause />}
      </Button>
      {props.canDrain && (
        <Button size="icon-xs" variant="ghost" className="hover:text-danger" title={hint ?? "Drain group (its waiting jobs)"} aria-label="Drain group" disabled={!props.proApi || props.busy} onClick={props.onDrain}>
          <Trash2 />
        </Button>
      )}
    </span>
  );
}

const PRO_API_DOCS = "https://github.com/madmorett/bullpane/blob/main/docs/BULLMQ-PRO.md";

/**
 * Without BullMQ Pro's package Bullpane only has core bullmq, which does not know
 * groups: the group actions do not exist there, and promote / retry / remove of a
 * grouped job would take it out of its group, so the server refuses them.
 */
function ProApiNotice() {
  return (
    <div className="flex items-start gap-2 rounded-md border border-border bg-surface-2/50 px-3 py-2 text-xs text-fg-muted" role="note">
      <Info className="mt-0.5 size-3.5 shrink-0 text-pro" aria-hidden />
      <span>
        Pausing, resuming and draining a group, and promoting, retrying or removing a grouped job, need BullMQ Pro&apos;s own package
        installed next to Bullpane: core bullmq would run those jobs outside their group.{" "}
        <a href={PRO_API_DOCS} target="_blank" rel="noreferrer" className="text-accent hover:underline">
          How to install it
        </a>
      </span>
    </div>
  );
}

/**
 * One chip per Pro status, in Pro's order (ZCARDs, exact), plus "delayed only": the
 * groups only the delayed scan sees, with how far that scan got.
 */
function StatusStrip({
  byStatus,
  total,
  delayedOnly,
  delayedScan,
}: {
  byStatus: GroupsByStatus;
  total: number;
  delayedOnly: number;
  delayedScan: ReturnType<typeof useDelayedGroupCounts> | null;
}) {
  const extra = delayedOnly;
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs">
      {GROUP_STATUSES.map((s) => (
        <Tooltip key={s} content={STATUS_HINT[s]} side="bottom">
          <span className={cn("inline-flex cursor-help items-center gap-1.5 rounded-md border border-border px-2 py-1", byStatus[s] === 0 && "opacity-60")}>
            <Badge variant={STATUS_VARIANT[s]} dot size="xs">
              {s}
            </Badge>
            <span className="num font-medium">{formatNumber(byStatus[s])}</span>
          </span>
        </Tooltip>
      ))}
      {delayedScan && (
        <Tooltip content={DELAYED_ONLY_HINT} side="bottom">
          <span className={cn("inline-flex cursor-help items-center gap-1.5 rounded-md border border-border px-2 py-1", extra === 0 && "opacity-60")}>
            <Badge variant="neutral" dot size="xs">
              delayed only
            </Badge>
            <span className="num font-medium">
              {delayedScan.loading ? "…" : formatNumber(extra)}
              {!delayedScan.complete && "+"}
            </span>
          </span>
        </Tooltip>
      )}
      <span className="text-fg-subtle">
        {formatNumber(total + extra)} {total + extra === 1 ? "group" : "groups"} with jobs
      </span>
      {delayedScan && !delayedScan.complete && !delayedScan.loading && (
        <span className="text-fg-subtle">
          · delayed counts from {formatNumber(delayedScan.scanned)} of {formatNumber(delayedScan.total)} delayed jobs
          {delayedScan.scanMore && (
            <>
              {" "}
              <button type="button" className="text-accent hover:underline" onClick={delayedScan.scanMore}>
                scan more
              </button>
            </>
          )}
        </span>
      )}
    </div>
  );
}

function GroupRow({ g, now, onOpen, href, delayed, select, actions }: { g: GroupSummary; now: number; onOpen: () => void; href: string; delayed: ReactNode; select: ReactNode; actions: ReactNode }) {
  const capped = g.concurrency !== null;
  const fill = capped ? Math.min(100, Math.round((g.active / Math.max(1, g.concurrency ?? 1)) * 100)) : 0;
  return (
    <Tr onActivate={onOpen}>
      {select}
      <Td mono>
        <Link to={href} className="text-accent hover:underline">
          {g.id}
        </Link>
      </Td>
      <Td className="whitespace-nowrap">
        <Badge variant={STATUS_VARIANT[g.status]} dot size="xs" title={STATUS_HINT[g.status]}>
          {g.status}
        </Badge>
      </Td>
      <Td num align="right">
        {formatNumber(g.waiting)}
        {g.prioritized > 0 && (
          <Tooltip content="Jobs added with opts.priority. Pro serves the group's plain list first, then these." side="bottom">
            <span className="ml-1.5 cursor-help text-[10px] text-fg-subtle">+{formatNumber(g.prioritized)} prioritized</span>
          </Tooltip>
        )}
      </Td>
      <Td num align="right">
        {delayed}
      </Td>
      <Td num align="right">
        <span className="inline-flex items-center justify-end gap-2">
          {capped && (
            <span className="h-1.5 w-14 overflow-hidden rounded-full bg-surface-2" aria-hidden>
              <span className={cn("block h-full rounded-full", fill >= 100 ? "bg-danger" : "bg-accent")} style={{ width: `${fill}%` }} />
            </span>
          )}
          <span>
            {formatNumber(g.active)}
            <span className="text-fg-subtle"> / </span>
            {capped ? (
              <Tooltip content="Per-group override set with queue.setGroupConcurrency()." side="bottom">
                <span className="cursor-help">{formatNumber(g.concurrency)}</span>
              </Tooltip>
            ) : (
              <Tooltip content={WORKER_DEFAULT_HINT} side="bottom">
                <span className="cursor-help text-fg-subtle">worker default</span>
              </Tooltip>
            )}
          </span>
        </span>
      </Td>
      <Td num align="right">
        {g.rateLimit ? (
          <Tooltip content="Per-group override set with queue.setGroupRateLimit(): max jobs per window." side="bottom">
            <span className="cursor-help">
              {formatNumber(g.rateLimit.max)}
              <span className="text-fg-subtle"> / </span>
              {formatDuration(g.rateLimit.durationMs)}
            </span>
          </Tooltip>
        ) : (
          <Tooltip content={WORKER_DEFAULT_HINT} side="bottom">
            <span className="cursor-help text-fg-subtle">worker default</span>
          </Tooltip>
        )}
      </Td>
      <Td num align="right" muted>
        <NextCell g={g} now={now} />
      </Td>
      {actions && <Td align="right">{actions}</Td>}
    </Tr>
  );
}

const DELAYED_ONLY_HINT =
  "Groups whose jobs are all delayed. BullMQ Pro keeps delayed jobs in the queue's delayed state and indexes the group only once one becomes due, so these come from a scan of the delayed jobs.";

/** A group only the delayed scan knows about: nothing waiting or running yet. */
function DelayedOnlyRow({ id, nextRunAt, now, onOpen, href, delayed, select, actions }: { id: string; nextRunAt: number; now: number; onOpen: () => void; href: string; delayed: ReactNode; select: ReactNode; actions: ReactNode }) {
  return (
    <Tr onActivate={onOpen}>
      {select}
      <Td mono>
        <Link to={href} className="text-accent hover:underline" onClick={(e) => e.stopPropagation()}>
          {id}
        </Link>
      </Td>
      <Td className="whitespace-nowrap">
        <Badge variant="neutral" dot size="xs" title={DELAYED_ONLY_HINT}>
          delayed only
        </Badge>
      </Td>
      <Td num align="right" muted>
        0
      </Td>
      <Td num align="right">
        {delayed}
      </Td>
      <Td num align="right" muted>
        –
      </Td>
      <Td num align="right" muted>
        –
      </Td>
      <Td num align="right" muted>
        {nextRunAt > now ? `first runs in ${formatDuration(nextRunAt - now)}` : "due"}
      </Td>
      {actions && <Td align="right">{actions}</Td>}
    </Tr>
  );
}

/** What happens next for the group, derived from the status zset score. */
function NextCell({ g, now }: { g: GroupSummary; now: number }) {
  if (g.status === "limited" && g.limitedUntil !== null) {
    const left = g.limitedUntil - now;
    return <span title={new Date(g.limitedUntil).toLocaleTimeString()}>{left > 0 ? `resumes in ${formatDuration(left)}` : "resuming…"}</span>;
  }
  if (g.status === "maxed" && g.since !== null) return <span title={new Date(g.since).toLocaleTimeString()}>at cap for {formatDuration(now - g.since)}</span>;
  if (g.status === "paused" && g.since !== null) return <span title={new Date(g.since).toLocaleTimeString()}>paused for {formatDuration(now - g.since)}</span>;
  if (g.status === "waiting") return <span>in rotation</span>;
  return <span>–</span>;
}

export function GroupJobsPage() {
  const { connectionId = "", queue = "", groupId = "" } = useParams();
  const { isOperator } = useAuth();
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const jobs = useGroupJobs(connectionId, queue, groupId, { page, pageSize });
  const jobAction = useJobAction(connectionId, queue);
  const { isAdmin } = useAuth();
  // page size 1: only for the bullmqProApi flag, the list itself is not shown here
  const proApi = useGroups(connectionId, queue, { page: 1, pageSize: 1 }).data?.bullmqProApi ?? false;
  const groupAction = useGroupAction(connectionId, queue);
  const [sp, setSp] = useSearchParams();
  // ?confirm=drain is the link the MCP hands out for a drain (request_destructive_action)
  const [confirmDrain, setConfirmDrain] = useState(sp.get("confirm") === "drain");
  const runGroup = (action: GroupActionKind) =>
    groupAction.mutate(
      { groupId, action },
      {
        onSuccess: () => toast.success(`Group ${groupId} ${action === "pause" ? "paused" : action === "resume" ? "resumed" : "drained"}`),
        onError: (e) => toast.error(errorMessage(e)),
        onSettled: () => {
          if (action === "drain") {
            setConfirmDrain(false);
            if (sp.has("confirm")) setSp((prev) => (prev.delete("confirm"), prev), { replace: true });
          }
        },
      },
    );
  const noProApi = proApi ? undefined : "Needs BullMQ Pro's package installed next to Bullpane";
  const [promoteOpen, setPromoteOpen] = useState(false);

  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  const run = (jobId: string, action: JobActionKind) =>
    jobAction.mutate({ jobId, action }, { onSuccess: () => toast.success(`Job ${jobId} ${action === "remove" ? "removed" : action}`), onError: (e) => toast.error(errorMessage(e)) });
  // Remove confirms here as it does on the queue page: the list repolls and
  // reorders, so the row under the cursor is not always the one you aimed at.
  const onAction = (jobId: string, action: JobActionKind) => (action === "remove" ? setConfirmRemove(jobId) : run(jobId, action));

  return (
    <Page wide>
      <PageHeader
        title={
          <span className="flex items-center gap-2">
            <Link to={routes.groups(connectionId, queue)} className="inline-flex items-center gap-1 text-fg-muted hover:text-fg">
              <ChevronLeft className="size-4" /> Groups
            </Link>
            <span className="text-fg-subtle">/</span>
            <Layers className="size-4 text-pro" aria-hidden />
            <span className="font-mono">{groupId}</span>
          </span>
        }
        description={`Jobs waiting in group ${groupId} of ${queue}, in the order Pro will serve them: the group's list first, then its prioritized jobs.`}
        actions={
          isOperator && (
            <div className="flex items-center gap-2">
              <Button size="sm" variant="secondary" leftIcon={<Pause />} disabled={!proApi || groupAction.isPending} title={noProApi} onClick={() => runGroup("pause")}>
                Pause group
              </Button>
              <Button size="sm" variant="secondary" leftIcon={<Play />} disabled={!proApi || groupAction.isPending} title={noProApi} onClick={() => runGroup("resume")}>
                Resume group
              </Button>
              <Button size="sm" variant="secondary" leftIcon={<FastForward />} disabled={!proApi} title={noProApi} onClick={() => setPromoteOpen(true)}>
                Promote all delayed
              </Button>
              {isAdmin && (
                <Button size="sm" variant="danger" leftIcon={<Trash2 />} disabled={!proApi || groupAction.isPending} title={noProApi} onClick={() => setConfirmDrain(true)}>
                  Drain group
                </Button>
              )}
            </div>
          )
        }
      />
      <p className="mb-3 text-xs text-fg-muted">
        Pro keeps the group&apos;s delayed, failed and completed jobs in the queue&apos;s own states, not here:{" "}
        {(["delayed", "failed", "completed"] as const).map((st, i) => (
          <span key={st}>
            {i > 0 && " · "}
            <Link to={routes.queueGroup(connectionId, queue, groupId, st)} className="text-accent hover:underline">
              {st}
            </Link>
          </span>
        ))}
      </p>
      {jobs.data && !proApi && <ProApiNotice />}
      <div className="card overflow-hidden">
        <JobsTable connectionId={connectionId} queue={queue} jobs={jobs.data?.jobs} loading={jobs.isLoading} error={jobs.error} canOperate={isOperator} onAction={onAction} pendingId={jobAction.isPending ? jobAction.variables?.jobId : null} emptyText="No jobs waiting in this group" />
        <div className="border-t border-border px-3 py-2">
          <Pagination page={page} pageSize={pageSize} total={jobs.data?.total ?? 0} count={jobs.data?.jobs.length} onPage={setPage} onPageSize={(s) => (setPageSize(s), setPage(1))} />
        </div>
      </div>
      <PromoteMatchingDialog open={promoteOpen} onClose={() => setPromoteOpen(false)} connectionId={connectionId} queue={queue} matches={[{ groupId }]} />
      <ConfirmDialog
        open={confirmDrain && proApi && isAdmin}
        onClose={() => setConfirmDrain(false)}
        title="Drain group"
        description={`Remove every waiting job of group ${groupId} in ${queue} (BullMQ Pro's deleteGroup)? Its delayed jobs stay in the queue's delayed state. This cannot be undone.`}
        confirmText="Drain group"
        danger
        loading={groupAction.isPending}
        onConfirm={() => runGroup("drain")}
      />
      <ConfirmDialog
        open={confirmRemove !== null}
        onClose={() => setConfirmRemove(null)}
        title="Remove job"
        description={`Remove job ${confirmRemove ?? ""} from ${queue}? This cannot be undone.`}
        confirmText="Remove"
        danger
        loading={jobAction.isPending}
        onConfirm={() => {
          if (confirmRemove) run(confirmRemove, "remove");
          setConfirmRemove(null);
        }}
      />
    </Page>
  );
}
