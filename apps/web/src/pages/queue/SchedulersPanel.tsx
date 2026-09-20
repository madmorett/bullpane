import { useState } from "react";
import { CalendarClock, Repeat, Trash2 } from "lucide-react";
import type { JobScheduler } from "@bullpane/shared";
import { cn } from "@/lib/cn";
import { formatDateTime, formatNumber, formatRelative } from "@/lib/format";
import { useRemoveScheduler, useSchedulers } from "@/api/hooks";
import { errorMessage } from "@/api/client";
import { useAuth } from "@/auth/AuthProvider";
import { toast } from "@/components/Toast";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Table, TableMessage, Td, Th, Tr } from "@/components/ui/Table";
import { Spinner } from "@/components/ui/Spinner";
import { Pagination } from "@/components/Pagination";
import { ConfirmDialog } from "@/components/ConfirmDialog";

/**
 * Job schedulers ("repeatable jobs"). They are invisible in the 8 job states —
 * BullMQ keeps them in the `repeat` zset — so this tab is the only place they show up.
 */
export function SchedulersPanel({ connectionId, queue }: { connectionId: string; queue: string }) {
  const { isOperator } = useAuth();
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [confirm, setConfirm] = useState<JobScheduler | null>(null);

  const schedulers = useSchedulers(connectionId, queue, { page, pageSize });
  const remove = useRemoveScheduler(connectionId, queue);

  const rows = schedulers.data?.schedulers ?? [];
  const total = schedulers.data?.total ?? 0;
  const cols = isOperator ? 6 : 5;

  const onRemove = (s: JobScheduler) =>
    remove.mutate(s.key, {
      onSuccess: () => {
        toast.success(`Scheduler ${s.key} removed`);
        setConfirm(null);
      },
      onError: (e) => toast.error(errorMessage(e)),
    });

  return (
    <>
      <div className="card overflow-hidden">
        <Table>
          <thead>
            <tr>
              <Th>Key</Th>
              <Th>Job name</Th>
              <Th>Repeats</Th>
              <Th>Timezone</Th>
              <Th align="right">Next run</Th>
              {isOperator && <Th align="right">Actions</Th>}
            </tr>
          </thead>
          <tbody>
            {schedulers.isLoading && (
              <TableMessage colSpan={cols}>
                <Spinner label="Loading schedulers…" />
              </TableMessage>
            )}
            {schedulers.isError && !schedulers.data && (
              <TableMessage colSpan={cols} className="text-danger">
                {errorMessage(schedulers.error)}
              </TableMessage>
            )}
            {schedulers.data && rows.length === 0 && (
              <TableMessage colSpan={cols}>
                <EmptyState queue={queue} />
              </TableMessage>
            )}
            {rows.map((s) => (
              <Tr key={s.key}>
                <Td mono>
                  <span className="text-fg" title={s.key}>
                    {s.key}
                  </span>
                  {s.template && (
                    <span className="ml-1.5 text-[11px] text-fg-subtle" title={templateTitle(s)}>
                      template
                    </span>
                  )}
                </Td>
                <Td mono muted>
                  {s.name}
                </Td>
                <Td>
                  <span className="flex flex-wrap items-center gap-1.5">
                    <Badge variant="outline" size="xs" className="font-mono">
                      {repeatLabel(s)}
                    </Badge>
                    {s.limit != null && (
                      <span className="text-[11px] text-fg-subtle" title="Maximum number of jobs this scheduler will ever produce">
                        {formatNumber(s.iterationCount ?? 0)}/{formatNumber(s.limit)} runs
                      </span>
                    )}
                    {s.limit == null && s.iterationCount != null && (
                      <span className="text-[11px] text-fg-subtle" title="Jobs produced so far">
                        {formatNumber(s.iterationCount)} runs
                      </span>
                    )}
                    {s.endDate != null && (
                      <span className="text-[11px] text-fg-subtle" title={`Stops after ${formatDateTime(s.endDate)}`}>
                        until {formatRelative(s.endDate)}
                      </span>
                    )}
                  </span>
                </Td>
                <Td muted>{s.tz ?? <span className="text-fg-subtle">–</span>}</Td>
                <Td align="right" num>
                  {s.next == null ? (
                    <span className="text-fg-subtle">–</span>
                  ) : (
                    <span className={cn(s.next <= Date.now() && "text-warning")} title={formatDateTime(s.next)}>
                      {formatRelative(s.next)}
                    </span>
                  )}
                </Td>
                {isOperator && (
                  <Td align="right">
                    <Button
                      size="sm"
                      variant="ghost"
                      className="text-fg-subtle hover:text-danger"
                      leftIcon={<Trash2 />}
                      aria-label={`Remove scheduler ${s.key}`}
                      title="Remove this scheduler"
                      loading={remove.isPending && remove.variables === s.key}
                      onClick={() => setConfirm(s)}
                    >
                      Remove
                    </Button>
                  </Td>
                )}
              </Tr>
            ))}
          </tbody>
        </Table>
        {total > 0 && (
          <div className={cn("border-t border-border px-3 py-2", schedulers.isFetching && "opacity-80")}>
            <Pagination page={page} pageSize={pageSize} total={total} count={rows.length} onPage={setPage} onPageSize={(s) => (setPageSize(s), setPage(1))} />
          </div>
        )}
      </div>

      <ConfirmDialog
        open={!!confirm}
        onClose={() => setConfirm(null)}
        title="Remove job scheduler"
        description={
          confirm
            ? `Stops "${confirm.key}" from producing new jobs and removes the job it already had scheduled. Jobs it produced in the past are not touched. Recreate it with queue.upsertJobScheduler().`
            : ""
        }
        confirmText="Remove"
        danger
        loading={remove.isPending}
        onConfirm={() => confirm && onRemove(confirm)}
      />
    </>
  );
}

/** `every: 30s` or the cron pattern, whichever the scheduler uses. */
export function repeatLabel(s: JobScheduler): string {
  if (s.every != null) return `every ${formatInterval(s.every)}`;
  if (s.pattern) return s.pattern;
  return "unknown";
}

/** 30000 -> "30s", 3600000 -> "1h". Keeps one decimal only when it matters. */
function formatInterval(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const units: [number, string][] = [
    [86_400_000, "d"],
    [3_600_000, "h"],
    [60_000, "m"],
    [1000, "s"],
  ];
  for (const [size, suffix] of units) {
    if (ms >= size) {
      const v = ms / size;
      return `${Number.isInteger(v) ? v : v.toFixed(1)}${suffix}`;
    }
  }
  return `${ms}ms`;
}

function templateTitle(s: JobScheduler): string {
  const parts = [`name: ${s.template?.name ?? s.name}`];
  if (s.template?.data) parts.push(`data: ${s.template.data}`);
  if (s.template?.opts) parts.push(`opts: ${s.template.opts}`);
  return parts.join("\n");
}

function EmptyState({ queue }: { queue: string }) {
  return (
    <div className="mx-auto flex max-w-xl flex-col items-center gap-2 py-6 text-center">
      <CalendarClock className="size-6 text-fg-subtle" aria-hidden />
      <p className="text-sm font-medium text-fg">No job schedulers on this queue</p>
      <p className="text-xs text-fg-muted">
        A job scheduler (BullMQ calls it a repeatable job) stamps out the same job on a cron pattern or a fixed interval. It lives outside the job states, so it never shows up
        under Waiting or Delayed — only the single job it has queued next does.
      </p>
      <pre className="mt-1 w-full overflow-x-auto rounded-md border border-border bg-surface-2 p-2.5 text-left font-mono text-[11px] leading-relaxed text-fg-muted">
        {`const queue = new Queue("${queue}");

await queue.upsertJobScheduler(
  "nightly-report",              // scheduler id
  { pattern: "0 3 * * *", tz: "America/Sao_Paulo" },
  { name: "report", data: { kind: "daily" } },
);

// or a fixed interval
await queue.upsertJobScheduler("heartbeat", { every: 30_000 });`}
      </pre>
      <p className="flex items-center gap-1.5 text-[11px] text-fg-subtle">
        <Repeat className="size-3" aria-hidden />
        upsertJobScheduler is idempotent: calling it again updates the schedule instead of adding a second one.
      </p>
    </div>
  );
}
