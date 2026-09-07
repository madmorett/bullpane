import { useState, type ReactNode } from "react";
import { Link, useNavigate } from "react-router-dom";
import { ArrowUpToLine, ExternalLink, RotateCcw, Trash2, Unplug } from "lucide-react";
import type { JobSummary } from "@bullpane/shared";
import type { JobSelection } from "@/lib/useJobSelection";
import { cn } from "@/lib/cn";
import { routes } from "@/lib/routes";
import { formatDateTime, formatDuration, tryPrettyJson } from "@/lib/format";
import type { JobActionKind } from "@/api/hooks";
import { Table, TableMessage, Td, Th, Tr } from "@/components/ui/Table";
import { Button } from "@/components/ui/Button";
import { Tooltip } from "@/components/ui/Tooltip";
import { RelativeTime } from "@/components/ui/RelativeTime";
import { Badge } from "@/components/ui/Badge";
import { Spinner } from "@/components/ui/Spinner";
import { StateBadge } from "@/components/StateBadge";

export interface JobsTableProps {
  connectionId: string;
  queue: string;
  jobs: JobSummary[] | undefined;
  loading?: boolean;
  error?: unknown;
  emptyText?: string;
  canOperate: boolean;
  onAction?: (jobId: string, action: JobActionKind) => void;
  pendingId?: string | null;
  /** show the state column (useful when jobs mix states, e.g. search or groups) */
  showState?: boolean;
  showGroup?: boolean;
  /** filter the list by this group when a group cell is clicked (Pro) */
  onGroupClick?: (groupId: string) => void;
  /** substring to <mark> inside the data preview / error (search results) */
  highlight?: string;
  compact?: boolean;
  /**
   * Seleção múltipla. Quando presente a tabela ganha a coluna de checkbox e o
   * cabeçalho de selecionar-a-página. A seleção é por jobId (ver
   * lib/useJobSelection.ts): a tabela repolla a cada 3 s e as linhas mudam de
   * posição, então um índice guardado apontaria para outro job.
   */
  selection?: JobSelection;
}

export function JobsTable({
  connectionId,
  queue,
  jobs,
  loading,
  error,
  emptyText = "No jobs in this state",
  canOperate,
  onAction,
  pendingId,
  showState = true,
  showGroup,
  onGroupClick,
  highlight,
  compact,
  selection,
}: JobsTableProps) {
  const navigate = useNavigate();
  const cols = 8 + (showState ? 1 : 0) + (showGroup ? 1 : 0) + (selection ? 1 : 0);
  const visibleCount = jobs?.length ?? 0;

  return (
    <Table dense={compact} className="min-w-[960px]">
      <thead>
        <tr>
          {selection && (
            <Th className="w-8">
              <input
                type="checkbox"
                className="size-3.5 cursor-pointer align-middle accent-[var(--accent)]"
                aria-label={selection.allVisibleSelected ? "Clear selection on this page" : "Select every job on this page"}
                title={selection.allVisibleSelected ? "Clear this page" : "Select this page"}
                checked={selection.allVisibleSelected}
                // Indeterminado quando parte da página está marcada: o operador
                // vê a diferença entre "nenhum", "alguns" e "todos".
                ref={(el) => {
                  if (el) el.indeterminate = !selection.allVisibleSelected && selection.visibleSelectedCount > 0;
                }}
                disabled={visibleCount === 0}
                onChange={selection.toggleAllVisible}
              />
            </Th>
          )}
          <Th className="w-28">ID</Th>
          {/*
            NAME é o primeiro argumento de `queue.add()` — o nome do JOB (o
            tipo/handler), não o da fila. Verificado contra Redis real: 
            `q.add("enviar-email", {...})` grava `name: "enviar-email"` no hash.
            Ninguém adivinha isso sozinho, então a coluna explica.
          */}
          <Th>
            <span className="cursor-help border-b border-dotted border-border-strong" title={'The job name — the first argument of queue.add("name", data). It is the job type / handler, not the queue name.'}>
              Name
            </span>
          </Th>
          {showState && <Th>State</Th>}
          {showGroup && <Th>Group</Th>}
          <Th className="w-24">Attempts</Th>
          <Th className="w-28">Created</Th>
          <Th className="w-28">Finished</Th>
          <Th className="w-24" align="right">
            Duration
          </Th>
          <Th>Data</Th>
          <Th className="w-28" align="right">
            <span className="sr-only">Actions</span>
          </Th>
        </tr>
      </thead>
      <tbody>
        {!!error && !jobs && (
          <TableMessage colSpan={cols} className="text-danger">
            Could not load jobs
          </TableMessage>
        )}
        {loading && !jobs && (
          <TableMessage colSpan={cols}>
            <Spinner label="Loading jobs…" />
          </TableMessage>
        )}
        {jobs && jobs.length === 0 && <TableMessage colSpan={cols}>{emptyText}</TableMessage>}
        {jobs?.map((job) => (
          <JobRow
            key={job.id}
            job={job}
            connectionId={connectionId}
            queue={queue}
            canOperate={canOperate}
            onAction={onAction}
            pending={pendingId === job.id}
            showState={showState}
            showGroup={!!showGroup}
            onGroupClick={onGroupClick}
            highlight={highlight}
            selection={selection}
            onOpen={() => navigate(routes.job(connectionId, queue, job.id))}
          />
        ))}
      </tbody>
    </Table>
  );
}

function JobRow({
  job,
  connectionId,
  queue,
  canOperate,
  onAction,
  pending,
  showState,
  showGroup,
  onGroupClick,
  highlight,
  selection,
  onOpen,
}: {
  job: JobSummary;
  connectionId: string;
  queue: string;
  canOperate: boolean;
  onAction?: (jobId: string, action: JobActionKind) => void;
  pending: boolean;
  showState: boolean;
  showGroup: boolean;
  onGroupClick?: (groupId: string) => void;
  highlight?: string;
  selection?: JobSelection;
  onOpen: () => void;
}) {
  const duration = job.processedOn && job.finishedOn ? job.finishedOn - job.processedOn : null;
  const wait = job.processedOn ? job.processedOn - job.timestamp : null;
  const canRetry = job.state === "failed" || job.state === "completed";
  const canPromote = job.state === "delayed";
  const selected = selection?.has(job.id) ?? false;

  return (
    <Tr onActivate={onOpen} selected={selected} className={cn(pending && "opacity-50")}>
      {selection && (
        <Td data-no-row-click>
          <input
            type="checkbox"
            className="size-3.5 cursor-pointer align-middle accent-[var(--accent)]"
            aria-label={`Select job ${job.id}`}
            checked={selected}
            onChange={() => undefined}
            // Shift+clique seleciona o intervalo. O evento de clique carrega o
            // shiftKey; o onChange não, por isso a lógica vive aqui.
            onClick={(e) => {
              e.stopPropagation();
              if (e.shiftKey) selection.toggleRange(job.id);
              else selection.toggle(job.id);
            }}
          />
        </Td>
      )}
      <Td mono>
        <Link to={routes.job(connectionId, queue, job.id)} className="text-accent hover:underline" title={job.id}>
          {job.id.length > 14 ? `${job.id.slice(0, 12)}…` : job.id}
        </Link>
      </Td>
      <Td>
        <span className="block max-w-56 truncate font-medium" title={job.name}>
          <Highlight text={job.name} needle={highlight} />
        </span>
      </Td>
      {showState && (
        <Td>
          <StateBadge state={job.state} size="xs" />
        </Td>
      )}
      {showGroup && (
        <Td mono muted data-no-row-click>
          {job.groupId ? (
            onGroupClick ? (
              <button type="button" className="max-w-40 truncate rounded px-1 text-left text-pro hover:bg-pro/10 hover:underline" title={`Show only group ${job.groupId}`} onClick={() => onGroupClick(job.groupId!)}>
                {job.groupId}
              </button>
            ) : (
              <Link to={routes.group(connectionId, queue, job.groupId)} className="text-pro hover:underline" title="Open group">
                {job.groupId}
              </Link>
            )
          ) : (
            "–"
          )}
        </Td>
      )}
      <Td num>
        <span className={cn(job.attemptsMade > 1 && "text-warning")}>
          {job.attemptsMade}
          {job.attempts != null && <span className="text-fg-subtle"> / {job.attempts}</span>}
        </span>
        {/*
          `stc` > 0: este job já stallou. NÃO é um estado — o job está `active`
          ou voltou para `wait`; o que aconteceu é que o worker perdeu o lock
          (morreu, travou, ou o event loop bloqueou) e o StalledCheck do BullMQ
          o recuperou. É a informação que faltava para explicar por que um job
          "rodou duas vezes".
        */}
        {job.stalledCounter > 0 && (
          <Badge variant="warning" size="xs" className="ml-1.5 gap-0.5" title={`Stalled ${job.stalledCounter} time${job.stalledCounter === 1 ? "" : "s"}: the worker lost the lock (it died or blocked) and BullMQ recovered the job. Not a state — the job went back to waiting.`}>
            <Unplug className="size-2.5" aria-hidden />
            {job.stalledCounter}
          </Badge>
        )}
        {job.priority > 0 && (
          <Badge variant="violet" size="xs" className="ml-1.5" title="priority">
            p{job.priority}
          </Badge>
        )}
      </Td>
      <Td muted>
        <RelativeTime value={job.timestamp} />
      </Td>
      <Td muted>
        <RelativeTime value={job.finishedOn} emptyText={job.processedOn ? "running…" : "–"} />
      </Td>
      <Td num align="right" muted>
        <Tooltip
          content={
            <>
              {wait != null && <>wait {formatDuration(wait)} · </>}
              {job.processedOn && <>started {formatDateTime(job.processedOn)}</>}
            </>
          }
          side="left"
        >
          <span>{duration != null ? formatDuration(duration) : job.processedOn ? formatDuration(Date.now() - job.processedOn) : "–"}</span>
        </Tooltip>
      </Td>
      <Td className="max-w-md">
        <DataPreview job={job} highlight={highlight} />
      </Td>
      <Td align="right" data-no-row-click>
        <div className="flex items-center justify-end gap-0.5">
          {canOperate && onAction && canRetry && (
            <Button size="icon-xs" variant="ghost" title="Retry" aria-label="Retry job" onClick={() => onAction(job.id, "retry")}>
              <RotateCcw />
            </Button>
          )}
          {canOperate && onAction && canPromote && (
            <Button size="icon-xs" variant="ghost" title="Promote" aria-label="Promote job" onClick={() => onAction(job.id, "promote")}>
              <ArrowUpToLine />
            </Button>
          )}
          {canOperate && onAction && (
            <Button size="icon-xs" variant="ghost" title="Remove" aria-label="Remove job" className="hover:text-danger" onClick={() => onAction(job.id, "remove")}>
              <Trash2 />
            </Button>
          )}
          <Button size="icon-xs" variant="ghost" title="Open" aria-label="Open job" onClick={onOpen}>
            <ExternalLink />
          </Button>
        </div>
      </Td>
    </Tr>
  );
}

/** Wraps case-insensitive occurrences of `needle` in <mark>. */
export function Highlight({ text, needle }: { text: string; needle?: string | null }): ReactNode {
  const n = needle?.trim();
  if (!n || !text) return text;
  const lower = text.toLowerCase();
  const nl = n.toLowerCase();
  const parts: ReactNode[] = [];
  let i = 0;
  let idx = lower.indexOf(nl, i);
  let guard = 0;
  while (idx >= 0 && guard++ < 200) {
    if (idx > i) parts.push(text.slice(i, idx));
    parts.push(<mark key={idx}>{text.slice(idx, idx + n.length)}</mark>);
    i = idx + n.length;
    idx = lower.indexOf(nl, i);
  }
  if (i < text.length) parts.push(text.slice(i));
  return <>{parts}</>;
}

function DataPreview({ job, highlight }: { job: JobSummary; highlight?: string }) {
  const [expanded, setExpanded] = useState(false);
  const preview = job.dataPreview ?? "";
  if (job.failedReason && !expanded) {
    return (
      <div className="flex flex-col gap-0.5" data-no-row-click>
        <button type="button" className="truncate text-left font-mono text-xs text-fg-muted hover:text-fg" onClick={() => setExpanded(true)} title="Expand">
          {preview ? <Highlight text={preview} needle={highlight} /> : <span className="text-fg-subtle">{"{}"}</span>}
        </button>
        <span className="truncate text-xs text-danger" title={job.failedReason}>
          <Highlight text={job.failedReason} needle={highlight} />
        </span>
      </div>
    );
  }
  if (!expanded) {
    return (
      <button
        type="button"
        data-no-row-click
        className="block w-full truncate text-left font-mono text-xs text-fg-muted hover:text-fg"
        onClick={() => setExpanded(true)}
        title="Expand"
      >
        {preview ? <Highlight text={preview} needle={highlight} /> : <span className="text-fg-subtle">{"{}"}</span>}
      </button>
    );
  }
  const pretty = job.dataTruncated ? null : tryPrettyJson(preview);
  return (
    <div data-no-row-click className="py-1">
      <pre className="max-h-64 overflow-auto rounded border border-border bg-bg p-2 font-mono text-[11px] leading-relaxed whitespace-pre-wrap break-all text-fg">
        <Highlight text={pretty ?? preview} needle={highlight} />
        {job.dataTruncated && <span className="text-fg-subtle"> … (truncated, open the job for the full payload)</span>}
      </pre>
      {job.failedReason && (
        <p className="mt-1 text-xs break-words text-danger">
          <Highlight text={job.failedReason} needle={highlight} />
        </p>
      )}
      <button type="button" className="mt-1 text-[11px] text-fg-subtle hover:text-fg" onClick={() => setExpanded(false)}>
        collapse
      </button>
    </div>
  );
}
