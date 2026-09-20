import { ArrowUpToLine, ChevronDown, ChevronRight, RotateCcw, Trash2, X } from "lucide-react";
import { useState } from "react";
import type { BulkJobAction, BulkJobActionResult, JobState } from "@bullpane/shared";
import { cn } from "@/lib/cn";
import { formatNumber } from "@/lib/format";
import { Button } from "@/components/ui/Button";
import type { JobSelection } from "@/lib/useJobSelection";

/**
 * Which actions make sense for the state on screen.
 *
 * It comes straight from what BullMQ allows (and from what the single actions
 * already checked in `inspector.retryJob` / `promoteJob`): `retry` only from
 * `failed`/`completed`, `promote` only from `delayed`. Showing a button that will
 * come back with 50 failures saying "cannot_retry_job_in_state_waiting" would be
 * worse than not showing it.
 *
 * `remove` is valid in any state — including `active`, where BullMQ refuses if the
 * job is locked; in that case the partial result gives the reason.
 */
export function bulkActionsFor(state: JobState | "mixed"): BulkJobAction[] {
  if (state === "mixed") return ["retry", "promote", "remove"];
  const actions: BulkJobAction[] = [];
  if (state === "failed" || state === "completed") actions.push("retry");
  if (state === "delayed") actions.push("promote");
  actions.push("remove");
  return actions;
}

const LABEL: Record<BulkJobAction, string> = { retry: "Retry", promote: "Promote", remove: "Remove" };

/**
 * The bar that appears when there is a selection. Three things it has to say well:
 *
 *  1. HOW MANY, and how many are off the visible page. The table repolls every
 *     3 s: a selected id that left the page stays selected, and dropping it
 *     silently would betray the operator's click.
 *  2. WHICH SET. With a search on screen, "select all" took the loaded SEARCH
 *     RESULTS, not the whole queue. Saying so avoids the expensive mistake.
 *  3. Bulk remove ALWAYS confirms (with the count and the queue name).
 */
export function BulkActionBar({
  selection,
  state,
  queue,
  actions,
  onRun,
  pending,
  searching,
  className,
}: {
  selection: JobSelection;
  /** the displayed state; decides which actions appear */
  state: JobState | "mixed";
  queue: string;
  /** override for the action list (QueuePage already knows the state) */
  actions?: BulkJobAction[];
  onRun: (action: BulkJobAction) => void;
  pending?: BulkJobAction | null;
  /** true when what is on screen are search results, not the whole queue */
  searching?: boolean;
  className?: string;
}) {
  const total = selection.selectedIds.length;
  if (total === 0) return null;
  const list = actions ?? bulkActionsFor(state);

  return (
    <div
      role="toolbar"
      aria-label="Bulk actions"
      className={cn("flex flex-wrap items-center gap-2 border-b border-border bg-accent/10 px-3 py-2 text-xs", className)}
    >
      <span className="font-medium text-fg">
        <span className="num">{formatNumber(total)}</span> selected
      </span>
      {selection.offPageCount > 0 && (
        <span className="text-fg-muted" title="Selection is kept by job id, so it survives the 3 s refresh and paging. These jobs are still selected and the action will include them.">
          (<span className="num">{formatNumber(selection.offPageCount)}</span> not on this page)
        </span>
      )}
      {searching && <span className="text-fg-subtle">· from the loaded search results, not the whole state</span>}
      <span className="flex-1" />
      {list.map((action) => (
        <Button
          key={action}
          size="sm"
          variant={action === "remove" ? "danger" : action === "retry" ? "primary" : "secondary"}
          leftIcon={action === "retry" ? <RotateCcw /> : action === "promote" ? <ArrowUpToLine /> : <Trash2 />}
          loading={pending === action}
          disabled={!!pending}
          onClick={() => onRun(action)}
        >
          {LABEL[action]}
        </Button>
      ))}
      <Button size="sm" variant="ghost" leftIcon={<X />} onClick={selection.clear} disabled={!!pending}>
        Clear
      </Button>
    </div>
  );
}

/**
 * The partial result, shown as a panel and not just as a toast: "47 retried ·
 * 3 failed" with the reasons expandable. A toast that disappears in 4 s is no
 * good for the operator who needs to write down which 3 ids were left behind.
 */
export function BulkResultPanel({ result, onDismiss }: { result: BulkJobActionResult; onDismiss: () => void }) {
  const [open, setOpen] = useState(false);
  const verb = result.action === "retry" ? "retried" : result.action === "promote" ? "promoted" : "removed";
  const failed = result.failed.length;

  return (
    <div className={cn("border-b border-border px-3 py-2 text-xs", failed > 0 ? "bg-warning/10" : "bg-state-completed/10")} role="status">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-fg">
          <span className="num font-semibold">{formatNumber(result.ok.length)}</span> {verb}
          {failed > 0 && (
            <>
              {" · "}
              <span className="num font-semibold text-warning">{formatNumber(failed)}</span> failed
            </>
          )}
        </span>
        {failed > 0 && (
          <button type="button" className="inline-flex items-center gap-0.5 text-fg-muted hover:text-fg" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
            {open ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
            {open ? "hide reasons" : "why?"}
          </button>
        )}
        <span className="flex-1" />
        <button type="button" className="rounded p-0.5 text-fg-subtle hover:text-fg" aria-label="Dismiss" onClick={onDismiss}>
          <X className="size-3.5" />
        </button>
      </div>
      {open && failed > 0 && (
        <ul className="mt-1.5 max-h-40 space-y-0.5 overflow-auto font-mono text-[11px] text-fg-muted">
          {result.failed.map((f) => (
            <li key={f.jobId}>
              <span className="text-fg">{f.jobId}</span> — {f.reason}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
