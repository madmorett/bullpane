/**
 * Every job scheduler of a connection, in one list.
 *
 * The per-queue tab (SchedulersPanel) answers "what does THIS queue schedule".
 * This page answers the question nobody could ask before: "what is this system
 * scheduled to do at all, and what fires next". Schedulers are invisible in the
 * 8 job states, so without this the only way to know was to click every queue.
 */
import { useState } from "react";
import { Link, Navigate, useNavigate, useParams } from "react-router-dom";
import { AlertTriangle, CalendarClock, Clock, Repeat, Search } from "lucide-react";
import type { ConnectionScheduler } from "@bullpane/shared";
import { cn } from "@/lib/cn";
import { routes } from "@/lib/routes";
import { formatDateTime, formatNumber, formatRelative } from "@/lib/format";
import { useAllSchedulers, useConnections } from "@/api/hooks";
import { errorMessage } from "@/api/client";
import { Badge } from "@/components/ui/Badge";
import { Input, Select } from "@/components/ui/Input";
import { Table, TableMessage, Td, Th, Tr } from "@/components/ui/Table";
import { Spinner } from "@/components/ui/Spinner";
import { EmptyState } from "@/components/ui/EmptyState";
import { Page, PageHeader } from "@/components/layout/AppShell";
import { repeatLabel } from "@/pages/queue/SchedulersPanel";

/** Windows for "what fires next". `0` means no filter. */
const WINDOWS: { label: string; ms: number }[] = [
  { label: "Any time", ms: 0 },
  { label: "Next hour", ms: 3_600_000 },
  { label: "Next 24 hours", ms: 86_400_000 },
  { label: "Next 7 days", ms: 604_800_000 },
];

/** /schedulers → first connection */
export function SchedulersIndexPage() {
  const connections = useConnections();
  if (connections.isLoading) {
    return (
      <Page>
        <Spinner label="Loading…" />
      </Page>
    );
  }
  const first = connections.data?.[0];
  if (!first) {
    return (
      <Page>
        <EmptyState icon={<CalendarClock />} title="No connections" description="Add a Redis connection first; schedulers are listed per connection." />
      </Page>
    );
  }
  return <Navigate to={routes.schedulers(first.id)} replace />;
}

export function SchedulersPage() {
  const { connectionId } = useParams<{ connectionId: string }>();
  const connections = useConnections();
  const navigate = useNavigate();
  const [search, setSearch] = useState("");
  const [windowMs, setWindowMs] = useState(0);

  const query = useAllSchedulers(connectionId, {
    ...(search.trim() ? { q: search.trim() } : {}),
    ...(windowMs > 0 ? { withinMs: windowMs } : {}),
  });

  const rows = query.data?.schedulers ?? [];
  const data = query.data;

  return (
    <Page>
      <PageHeader
        title="Schedulers"
        description={
          data
            ? `${formatNumber(data.total)} across ${formatNumber(data.queuesWithSchedulers)} of ${formatNumber(data.queuesScanned)} queues`
            : undefined
        }
        actions={
          connections.data && connections.data.length > 1 ? (
            <Select
              aria-label="Connection"
              value={connectionId ?? ""}
              onChange={(e) => navigate(routes.schedulers(e.target.value))}
            >
              {connections.data.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
          ) : undefined
        }
      />
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Filter by scheduler id, job name or queue…"
          aria-label="Filter schedulers"
          leftIcon={<Search className="size-3.5" />}
          className="w-full sm:w-80"
        />
        <Select aria-label="Next run within" value={String(windowMs)} onChange={(e) => setWindowMs(Number(e.target.value))}>
          {WINDOWS.map((w) => (
            <option key={w.ms} value={w.ms}>
              {w.label}
            </option>
          ))}
        </Select>
        {query.isFetching && <Spinner className="size-3.5" />}
      </div>

      {/* A queue whose scheduler read failed does not blank the page — it is reported here. */}
      {data && data.failed.length > 0 && (
        <div className="mb-3 flex items-start gap-2 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-fg-muted">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-warning" aria-hidden />
          <span>
            Could not read schedulers from {data.failed.length} queue{data.failed.length === 1 ? "" : "s"}:{" "}
            <span className="font-mono">{data.failed.map((f) => f.queueName).join(", ")}</span>. The rest of the list is complete.
          </span>
        </div>
      )}

      <div className="card overflow-hidden">
        <Table>
          <thead>
            <tr>
              <Th>Queue</Th>
              <Th>Scheduler</Th>
              <Th>Job name</Th>
              <Th>Repeats</Th>
              <Th align="right">Next run</Th>
            </tr>
          </thead>
          <tbody>
            {query.isLoading && (
              <TableMessage colSpan={5}>
                <Spinner label="Reading schedulers…" />
              </TableMessage>
            )}
            {query.isError && !data && (
              <TableMessage colSpan={5} className="text-danger">
                {errorMessage(query.error)}
              </TableMessage>
            )}
            {data && rows.length === 0 && (
              <TableMessage colSpan={5}>
                <NoSchedulers filtered={!!search.trim() || windowMs > 0} total={data.total} />
              </TableMessage>
            )}
            {rows.map((s) => (
              <SchedulerRow key={`${s.queueName}:${s.key}`} s={s} connectionId={connectionId!} />
            ))}
          </tbody>
        </Table>
      </div>

      {data && rows.length > 0 && rows.length < data.total && (
        <p className="mt-2 text-[11px] text-fg-subtle">
          Showing {formatNumber(rows.length)} of {formatNumber(data.total)}. Narrow the filter to see the rest.
        </p>
      )}
    </Page>
  );
}

function SchedulerRow({ s, connectionId }: { s: ConnectionScheduler; connectionId: string }) {
  const overdue = s.next != null && s.next <= Date.now();
  return (
    <Tr>
      <Td>
        <Link to={routes.queueSchedulers(connectionId, s.queueName)} className="text-accent hover:underline">
          {s.queueName}
        </Link>
      </Td>
      <Td mono>
        <span className="text-fg" title={s.key}>
          {s.key}
        </span>
      </Td>
      <Td mono muted>
        {s.name}
      </Td>
      <Td>
        <span className="flex flex-wrap items-center gap-1.5">
          <Badge variant="outline" size="xs" className="font-mono">
            {repeatLabel(s)}
          </Badge>
          {s.tz && <span className="text-[11px] text-fg-subtle">{s.tz}</span>}
          {/* A scheduler that exists but has never produced a job is almost always
              a bug — a typo'd pattern, or a worker that was never started. */}
          {s.iterationCount === 0 && (
            <span className="text-[11px] text-warning" title="This scheduler has never produced a job">
              never ran
            </span>
          )}
        </span>
      </Td>
      <Td align="right" num>
        {s.next == null ? (
          <span className="text-fg-subtle" title="No next run: the scheduler ended or hit its limit">
            –
          </span>
        ) : (
          <span className={cn("inline-flex items-center gap-1", overdue && "text-warning")} title={formatDateTime(s.next)}>
            {overdue && <Clock className="size-3" aria-hidden />}
            {formatRelative(s.next)}
          </span>
        )}
      </Td>
    </Tr>
  );
}

function NoSchedulers({ filtered, total }: { filtered: boolean; total: number }) {
  if (filtered && total > 0) {
    return (
      <div className="py-6 text-center text-sm text-fg-muted">
        No scheduler matches this filter. This connection has {formatNumber(total)} in total.
      </div>
    );
  }
  return (
    <div className="mx-auto flex max-w-xl flex-col items-center gap-2 py-6 text-center">
      <CalendarClock className="size-6 text-fg-subtle" aria-hidden />
      <p className="text-sm font-medium text-fg">No job schedulers on this connection</p>
      <p className="text-xs text-fg-muted">
        A job scheduler (BullMQ calls it a repeatable job) stamps out the same job on a cron pattern or a fixed interval. It lives outside the job states, so it never
        shows up under Waiting or Delayed — only the single job it has queued next does.
      </p>
      <p className="flex items-center gap-1.5 text-[11px] text-fg-subtle">
        <Repeat className="size-3" aria-hidden />
        Create one with <span className="font-mono">queue.upsertJobScheduler()</span>.
      </p>
    </div>
  );
}
