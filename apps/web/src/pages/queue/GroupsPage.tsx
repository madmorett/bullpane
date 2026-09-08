import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { ChevronLeft, Layers } from "lucide-react";
import { GROUP_STATUSES, type GroupStatus, type GroupSummary, type GroupsByStatus } from "@bullpane/shared";
import { routes } from "@/lib/routes";
import { cn } from "@/lib/cn";
import { formatDuration, formatNumber } from "@/lib/format";
import { useNow } from "@/lib/useNow";
import { useGroupJobs, useGroups, useJobAction, useQueue, type JobActionKind } from "@/api/hooks";
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
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const summary = useQueue(connectionId, queue);
  const groups = useGroups(connectionId, queue, { page, pageSize });
  const now = useNow(1000);
  const cols = 6;

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
        description={`Groups partition a queue for fairness, with their own concurrency and rate limit. ${summary.data ? `${formatNumber(summary.data.groupsCount)} groups with jobs.` : ""}`}
      />

      {groups.data && <StatusStrip byStatus={groups.data.byStatus} total={groups.data.total} />}

      <div className="card overflow-hidden">
        <Table>
          <thead>
            <tr>
              <Th>Group</Th>
              <Th>Status</Th>
              <Th align="right">Waiting</Th>
              <Th align="right">Active / concurrency</Th>
              <Th align="right">Rate limit</Th>
              <Th align="right">Next</Th>
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
            {groups.data && groups.data.groups.length === 0 && (
              <TableMessage colSpan={cols}>No groups with jobs right now. Add jobs with opts.group.id to see them here.</TableMessage>
            )}
            {groups.data?.groups.map((g) => (
              <GroupRow key={g.id} g={g} now={now} onOpen={() => navigate(routes.group(connectionId, queue, g.id))} href={routes.group(connectionId, queue, g.id)} />
            ))}
          </tbody>
        </Table>
        <div className="border-t border-border px-3 py-2">
          <Pagination page={page} pageSize={pageSize} total={groups.data?.total ?? 0} count={groups.data?.groups.length} onPage={setPage} onPageSize={(s) => (setPageSize(s), setPage(1))} />
        </div>
      </div>
    </Page>
  );
}

/** One chip per Pro status, in Pro's order. Counts are ZCARDs, so they are exact. */
function StatusStrip({ byStatus, total }: { byStatus: GroupsByStatus; total: number }) {
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
      <span className="text-fg-subtle">
        {formatNumber(total)} {total === 1 ? "group" : "groups"} with jobs
      </span>
    </div>
  );
}

function GroupRow({ g, now, onOpen, href }: { g: GroupSummary; now: number; onOpen: () => void; href: string }) {
  const capped = g.concurrency !== null;
  const fill = capped ? Math.min(100, Math.round((g.active / Math.max(1, g.concurrency ?? 1)) * 100)) : 0;
  return (
    <Tr onActivate={onOpen}>
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

  const onAction = (jobId: string, action: JobActionKind) =>
    jobAction.mutate({ jobId, action }, { onSuccess: () => toast.success(`Job ${jobId} ${action === "remove" ? "removed" : action}`), onError: (e) => toast.error(errorMessage(e)) });

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
      />
      <div className="card overflow-hidden">
        <JobsTable connectionId={connectionId} queue={queue} jobs={jobs.data?.jobs} loading={jobs.isLoading} error={jobs.error} canOperate={isOperator} onAction={onAction} pendingId={jobAction.isPending ? jobAction.variables?.jobId : null} emptyText="No jobs waiting in this group" />
        <div className="border-t border-border px-3 py-2">
          <Pagination page={page} pageSize={pageSize} total={jobs.data?.total ?? 0} count={jobs.data?.jobs.length} onPage={setPage} onPageSize={(s) => (setPageSize(s), setPage(1))} />
        </div>
      </div>
    </Page>
  );
}
