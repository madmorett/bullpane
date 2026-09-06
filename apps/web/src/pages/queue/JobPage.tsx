import { useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { ArrowUpToLine, Ban, ChevronLeft, GitBranch, RotateCcw, Trash2 } from "lucide-react";
import type { JobDetail } from "@bullmq-visualizer/shared";
import { cn } from "@/lib/cn";
import { queueNameFromKey, routes } from "@/lib/routes";
import { formatDateTimeMs, formatDuration, formatNumber, safeJsonStringify } from "@/lib/format";
import { useJob, useJobAction, useJobLogs, type JobActionKind } from "@/api/hooks";
import { errorMessage, isApiError } from "@/api/client";
import { useAuth } from "@/auth/AuthProvider";
import { toast } from "@/components/Toast";
import { Page } from "@/components/layout/AppShell";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { Tabs } from "@/components/ui/Tabs";
import { CopyButton } from "@/components/ui/CopyButton";
import { CodeBlock } from "@/components/ui/CodeBlock";
import { JsonView } from "@/components/ui/JsonView";
import { RelativeTime } from "@/components/ui/RelativeTime";
import { EmptyState } from "@/components/ui/EmptyState";
import { PageSpinner } from "@/components/ui/Spinner";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { StateBadge, STATE_META } from "@/components/StateBadge";
import { useNow } from "@/lib/useNow";

type Tab = "data" | "opts" | "returnvalue" | "error" | "logs";

export function JobPage() {
  const { connectionId = "", queue = "", jobId = "" } = useParams();
  const navigate = useNavigate();
  const { isOperator } = useAuth();
  const job = useJob(connectionId, queue, jobId);
  const action = useJobAction(connectionId, queue);
  const [tab, setTab] = useState<Tab>("data");
  const [confirm, setConfirm] = useState<null | "remove" | "discard">(null);

  const run = (kind: JobActionKind) =>
    action.mutate(
      { jobId, action: kind },
      {
        onSuccess: () => {
          toast.success(`Job ${jobId} ${kind === "remove" ? "removed" : kind === "retry" ? "retried" : kind === "promote" ? "promoted" : "discarded"}`);
          setConfirm(null);
          if (kind === "remove") navigate(routes.queue(connectionId, queue));
        },
        onError: (e) => toast.error(errorMessage(e)),
      },
    );

  if (job.isLoading) {
    return (
      <Page>
        <PageSpinner label="Loading job…" />
      </Page>
    );
  }
  if (job.isError || !job.data) {
    const notFound = isApiError(job.error) && job.error.status === 404;
    return (
      <Page>
        <EmptyState
          title={notFound ? "Job not found" : "Could not load job"}
          description={notFound ? "It may have been removed or cleaned since you opened it." : errorMessage(job.error)}
          action={
            <Button variant="secondary" leftIcon={<ChevronLeft />} onClick={() => navigate(routes.queue(connectionId, queue))}>
              Back to {queue}
            </Button>
          }
        />
      </Page>
    );
  }

  const d = job.data;
  const canRetry = d.state === "failed" || d.state === "completed";
  const canPromote = d.state === "delayed";
  const hasError = !!d.failedReason || (d.stacktrace?.length ?? 0) > 0;

  return (
    <Page>
      {/* Header */}
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <Link to={routes.queue(connectionId, queue, d.state !== "unknown" ? d.state : undefined)} className="mb-1 inline-flex items-center gap-1 text-xs text-fg-muted hover:text-fg">
            <ChevronLeft className="size-3.5" /> {queue}
          </Link>
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="truncate text-lg font-semibold tracking-tight">{d.name}</h1>
            <StateBadge state={d.state} />
            {d.groupId && (
              <Link to={routes.group(connectionId, queue, d.groupId)}>
                <Badge variant="pro" mono title="BullMQ Pro group">
                  group {d.groupId}
                </Badge>
              </Link>
            )}
            {d.priority > 0 && <Badge variant="violet">priority {d.priority}</Badge>}
          </div>
          <p className="mt-1 flex items-center gap-1 font-mono text-xs text-fg-muted">
            <span className="select-all">{d.id}</span>
            <CopyButton value={d.id} label="Copy id" size="icon-xs" />
            <CopyButton value={() => safeJsonStringify(d)} label="Copy JSON" size="icon-xs" />
          </p>
        </div>
        {isOperator && (
          <div className="flex flex-wrap items-center gap-2">
            {canRetry && (
              <Button size="sm" leftIcon={<RotateCcw />} onClick={() => run("retry")} loading={action.isPending && action.variables?.action === "retry"}>
                Retry
              </Button>
            )}
            {canPromote && (
              <Button size="sm" leftIcon={<ArrowUpToLine />} onClick={() => run("promote")} loading={action.isPending && action.variables?.action === "promote"}>
                Promote
              </Button>
            )}
            <Button size="sm" variant="ghost" leftIcon={<Ban />} onClick={() => setConfirm("discard")} title="Mark as not retryable">
              Discard
            </Button>
            <Button size="sm" variant="ghost" className="hover:text-danger" leftIcon={<Trash2 />} onClick={() => setConfirm("remove")}>
              Remove
            </Button>
          </div>
        )}
      </div>

      {/* Meta + timeline */}
      <div className="mb-4 grid gap-3 lg:grid-cols-3">
        <div className="card p-4 lg:col-span-2">
          <Timeline job={d} />
        </div>
        <dl className="card grid grid-cols-2 gap-x-4 gap-y-3 p-4 text-xs">
          <Meta label="Attempts">
            <span className={cn(d.attemptsMade > 1 && "text-warning")}>
              {d.attemptsMade}
              {d.attempts != null && <span className="text-fg-subtle"> / {d.attempts}</span>}
            </span>
          </Meta>
          <Meta label="Delay">{d.delay ? formatDuration(d.delay) : "–"}</Meta>
          <Meta label="Priority">{d.priority || "–"}</Meta>
          <Meta label="Progress">
            <Progress value={d.progress} />
          </Meta>
          <Meta label="Parent">
            {d.parent ? (
              <Link to={routes.job(connectionId, queueNameFromKey(d.parent.queueKey), d.parent.id)} className="inline-flex items-center gap-1 font-mono text-accent hover:underline">
                <GitBranch className="size-3" />
                {d.parent.queue || queueNameFromKey(d.parent.queueKey)}/{d.parent.id}
              </Link>
            ) : (
              "–"
            )}
          </Meta>
          <Meta label="Children">
            {d.dependencies ? (
              <span>
                <span className="text-success">{formatNumber(d.dependencies.processed)}</span> done ·{" "}
                <span className={cn(d.dependencies.unprocessed > 0 && "text-teal")}>{formatNumber(d.dependencies.unprocessed)}</span> pending
              </span>
            ) : (
              "–"
            )}
          </Meta>
        </dl>
      </div>

      {/* Tabs */}
      <Tabs<Tab>
        aria-label="Job details"
        size="sm"
        className="mb-3"
        value={tab}
        onChange={setTab}
        items={[
          { value: "data", label: "Data" },
          { value: "opts", label: "Options", count: Object.keys(d.opts ?? {}).length },
          { value: "returnvalue", label: "Return value" },
          { value: "error", label: "Error", tone: hasError ? "bg-danger" : undefined },
          { value: "logs", label: "Logs", count: d.logsCount ?? d.logs?.length ?? 0 },
        ]}
      />

      {tab === "data" && <JsonPanel value={d.data} empty="No data" />}
      {tab === "opts" && <JsonPanel value={d.opts} empty="No options" />}
      {tab === "returnvalue" && <JsonPanel value={d.returnvalue} empty="No return value (job has not completed)" />}
      {tab === "error" && <ErrorPanel job={d} />}
      {tab === "logs" && <LogsPanel connectionId={connectionId} queue={queue} jobId={jobId} initial={d.logs} total={d.logsCount} />}

      <ConfirmDialog
        open={confirm === "remove"}
        onClose={() => setConfirm(null)}
        title="Remove job"
        description={`Job ${jobId} will be deleted from ${queue}. Active jobs cannot be removed while locked.`}
        confirmText="Remove"
        danger
        loading={action.isPending}
        onConfirm={() => run("remove")}
      />
      <ConfirmDialog
        open={confirm === "discard"}
        onClose={() => setConfirm(null)}
        title="Discard job"
        description="Marks the job as not retryable: attemptsMade is set to the max so backoff retries stop. The job itself is kept."
        confirmText="Discard"
        loading={action.isPending}
        onConfirm={() => run("discard")}
      />
    </Page>
  );
}

function Meta({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-[10px] tracking-wide text-fg-subtle uppercase">{label}</dt>
      <dd className="num truncate text-[13px] text-fg">{children}</dd>
    </div>
  );
}

function Progress({ value }: { value: JobDetail["progress"] }) {
  if (value == null) return <>–</>;
  if (typeof value === "number") {
    const pct = Math.max(0, Math.min(100, value));
    return (
      <span className="flex items-center gap-2">
        <span className="h-1.5 w-16 overflow-hidden rounded bg-surface-3">
          <span className="block h-full bg-accent" style={{ width: `${pct}%` }} />
        </span>
        <span>{pct}%</span>
      </span>
    );
  }
  return <span className="font-mono text-[11px]" title={safeJsonStringify(value)}>{safeJsonStringify(value, 0).slice(0, 40)}</span>;
}

function Timeline({ job }: { job: JobDetail }) {
  const now = useNow(1000);
  const created = job.timestamp;
  const started = job.processedOn;
  const finished = job.finishedOn;
  const wait = started ? started - created : job.state === "waiting" || job.state === "delayed" || job.state === "prioritized" ? now - created : null;
  const run = started ? (finished ?? (job.state === "active" ? now : null)) : null;
  const runMs = started && run ? run - started : null;
  const steps = [
    { label: "Created", ts: created, tone: "bg-info" },
    { label: "Processed", ts: started, tone: "bg-accent" },
    { label: finished ? (job.state === "failed" ? "Failed" : "Finished") : "Finished", ts: finished, tone: job.state === "failed" ? "bg-danger" : "bg-success" },
  ];
  return (
    <div>
      <h2 className="mb-3 text-[10px] font-semibold tracking-wider text-fg-subtle uppercase">Timeline</h2>
      <ol className="relative flex items-start justify-between gap-2">
        <span className="absolute top-[7px] right-4 left-4 -z-0 h-px bg-border" aria-hidden />
        {steps.map((s, i) => (
          <li key={s.label} className={cn("relative z-[1] flex flex-1 flex-col", i === 1 ? "items-center text-center" : i === 2 ? "items-end text-right" : "items-start")}>
            <span className={cn("status-dot size-3.5 ring-4 ring-surface", s.ts ? s.tone : "bg-surface-3", !s.ts && job.state === "active" && i === 2 && "pulse bg-accent/50")} />
            <span className="mt-1.5 text-xs font-medium text-fg">{s.label}</span>
            <span className="text-[11px] text-fg-muted">{s.ts ? <RelativeTime value={s.ts} /> : job.state === "active" && i === 2 ? "running…" : "–"}</span>
            {s.ts && <span className="font-mono text-[10px] text-fg-subtle">{formatDateTimeMs(s.ts)}</span>}
          </li>
        ))}
      </ol>
      <div className="mt-4 flex flex-wrap gap-4 border-t border-border pt-3 text-xs">
        <span>
          <span className="text-fg-subtle">Wait </span>
          <span className="num text-fg">{wait != null ? formatDuration(wait) : "–"}</span>
        </span>
        <span>
          <span className="text-fg-subtle">Run </span>
          <span className={cn("num text-fg", job.state === "active" && "text-accent")}>{runMs != null ? formatDuration(runMs) : "–"}</span>
        </span>
        <span>
          <span className="text-fg-subtle">Total </span>
          <span className="num text-fg">{finished ? formatDuration(finished - created) : "–"}</span>
        </span>
        <span className="ml-auto flex items-center gap-1.5 text-fg-subtle">
          <span className={cn("status-dot", STATE_META[job.state]?.dot ?? "bg-fg-subtle")} /> {job.state}
        </span>
      </div>
    </div>
  );
}

function JsonPanel({ value, empty }: { value: unknown; empty: string }) {
  const [raw, setRaw] = useState(false);
  const text = useMemo(() => safeJsonStringify(value), [value]);
  const isEmpty = value === undefined || value === null || (typeof value === "object" && Object.keys(value as object).length === 0);
  return (
    <div className="card">
      <div className="flex h-8 items-center justify-between border-b border-border bg-surface-2/60 pr-1 pl-3">
        <div className="flex items-center gap-1 text-[11px]">
          <button type="button" className={cn("rounded px-1.5 py-0.5", !raw ? "bg-surface-3 text-fg" : "text-fg-subtle hover:text-fg")} onClick={() => setRaw(false)}>
            Tree
          </button>
          <button type="button" className={cn("rounded px-1.5 py-0.5", raw ? "bg-surface-3 text-fg" : "text-fg-subtle hover:text-fg")} onClick={() => setRaw(true)}>
            Raw
          </button>
        </div>
        <CopyButton value={text} size="icon-xs" />
      </div>
      <div className="max-h-[60vh] overflow-auto p-3">
        {isEmpty ? <p className="text-xs text-fg-subtle">{empty}</p> : raw ? <pre className="font-mono text-xs leading-relaxed whitespace-pre-wrap break-all">{text}</pre> : <JsonView value={value} defaultExpandDepth={3} />}
      </div>
    </div>
  );
}

function ErrorPanel({ job }: { job: JobDetail }) {
  if (!job.failedReason && (!job.stacktrace || job.stacktrace.length === 0)) {
    return (
      <div className="card p-6 text-center text-xs text-fg-subtle">
        No error recorded for this job
      </div>
    );
  }
  return (
    <div className="space-y-3">
      {job.failedReason && (
        <div className="rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-[13px] break-words text-danger">
          {job.failedReason}
        </div>
      )}
      {job.stacktrace?.map((frame, i) => (
        <CodeBlock key={i} code={frame} header={`Stacktrace · attempt ${i + 1} of ${job.stacktrace.length}`} wrap maxHeight={360} />
      ))}
    </div>
  );
}

function LogsPanel({ connectionId, queue, jobId, initial, total }: { connectionId: string; queue: string; jobId: string; initial: string[]; total: number }) {
  const [all, setAll] = useState(false);
  const logs = useJobLogs(connectionId, queue, jobId, all ? {} : { start: 0, end: 199 }, true);
  const lines = logs.data?.logs ?? initial ?? [];
  const count = logs.data?.count ?? total ?? lines.length;
  if (lines.length === 0) return <div className="card p-6 text-center text-xs text-fg-subtle">No logs. Use job.log() in your processor to emit lines here.</div>;
  return (
    <div className="card">
      <div className="flex h-8 items-center justify-between border-b border-border bg-surface-2/60 pr-1 pl-3 text-[11px] text-fg-subtle">
        <span>
          {formatNumber(lines.length)} of {formatNumber(count)} lines
        </span>
        <div className="flex items-center gap-1">
          {!all && lines.length < count && (
            <Button size="xs" variant="ghost" onClick={() => setAll(true)}>
              Load all
            </Button>
          )}
          <CopyButton value={lines.join("\n")} size="icon-xs" />
        </div>
      </div>
      <ol className="max-h-[60vh] overflow-auto p-2 font-mono text-xs leading-relaxed">
        {lines.map((l, i) => (
          <li key={i} className="flex gap-3 hover:bg-surface-2/50">
            <span className="num w-10 shrink-0 select-none text-right text-fg-subtle">{i + 1}</span>
            <span className="whitespace-pre-wrap break-all">{l}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}
