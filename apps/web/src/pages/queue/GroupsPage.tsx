import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { ChevronLeft, Layers } from "lucide-react";
import type { GroupSummary } from "@bullmq-visualizer/shared";
import { routes } from "@/lib/routes";
import { formatNumber } from "@/lib/format";
import { useGroupJobs, useGroups, useJobAction, useQueue, type JobActionKind } from "@/api/hooks";
import { errorMessage } from "@/api/client";
import { useAuth } from "@/auth/AuthProvider";
import { toast } from "@/components/Toast";
import { Page, PageHeader } from "@/components/layout/AppShell";
import { Badge, type BadgeVariant } from "@/components/ui/Badge";
import { Table, TableMessage, Td, Th, Tr } from "@/components/ui/Table";
import { Spinner } from "@/components/ui/Spinner";
import { Pagination } from "@/components/Pagination";
import { JobsTable } from "@/components/JobsTable";

const STATUS_VARIANT: Record<GroupSummary["status"], BadgeVariant> = {
  active: "accent",
  waiting: "info",
  paused: "warning",
  "rate-limited": "violet",
  maxed: "danger",
  unknown: "outline",
};

export function GroupsPage() {
  const { connectionId = "", queue = "" } = useParams();
  const navigate = useNavigate();
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const summary = useQueue(connectionId, queue);
  const groups = useGroups(connectionId, queue, { page, pageSize });

  return (
    <Page>
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
        description={`Groups partition a queue for fairness and per-group concurrency. ${summary.data ? `${formatNumber(summary.data.groupsCount)} groups detected.` : ""}`}
      />
      <div className="card overflow-hidden">
        <Table>
          <thead>
            <tr>
              <Th>Group</Th>
              <Th>Status</Th>
              <Th align="right">Waiting</Th>
              <Th align="right">Score</Th>
            </tr>
          </thead>
          <tbody>
            {groups.isLoading && (
              <TableMessage colSpan={4}>
                <Spinner label="Loading groups…" />
              </TableMessage>
            )}
            {groups.isError && !groups.data && (
              <TableMessage colSpan={4} className="text-danger">
                {errorMessage(groups.error)}
              </TableMessage>
            )}
            {groups.data && groups.data.groups.length === 0 && <TableMessage colSpan={4}>No groups. Add jobs with opts.group.id to see them here.</TableMessage>}
            {groups.data?.groups.map((g) => (
              <Tr key={g.id} onActivate={() => navigate(routes.group(connectionId, queue, g.id))}>
                <Td mono>
                  <Link to={routes.group(connectionId, queue, g.id)} className="text-accent hover:underline">
                    {g.id}
                  </Link>
                </Td>
                <Td>
                  <Badge variant={STATUS_VARIANT[g.status] ?? "outline"} dot size="xs">
                    {g.status}
                  </Badge>
                </Td>
                <Td num align="right">
                  {formatNumber(g.waiting)}
                </Td>
                <Td num align="right" muted>
                  {g.score}
                </Td>
              </Tr>
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
        description={`Jobs waiting in group ${groupId} of ${queue}.`}
      />
      <div className="card overflow-hidden">
        <JobsTable connectionId={connectionId} queue={queue} jobs={jobs.data?.jobs} loading={jobs.isLoading} error={jobs.error} canOperate={isOperator} onAction={onAction} pendingId={jobAction.isPending ? jobAction.variables?.jobId : null} emptyText="No jobs in this group" />
        <div className="border-t border-border px-3 py-2">
          <Pagination page={page} pageSize={pageSize} total={jobs.data?.total ?? 0} count={jobs.data?.jobs.length} onPage={setPage} onPageSize={(s) => (setPageSize(s), setPage(1))} />
        </div>
      </div>
    </Page>
  );
}
