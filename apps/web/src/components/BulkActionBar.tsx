import { ArrowUpToLine, ChevronDown, ChevronRight, RotateCcw, Trash2, X } from "lucide-react";
import { useState } from "react";
import type { BulkJobAction, BulkJobActionResult, JobState } from "@bullpane/shared";
import { cn } from "@/lib/cn";
import { formatNumber } from "@/lib/format";
import { Button } from "@/components/ui/Button";
import type { JobSelection } from "@/lib/useJobSelection";

/**
 * Quais ações fazem sentido para o estado que está na tela.
 *
 * Vem direto do que o BullMQ permite (e do que as ações unitárias já checavam
 * em `inspector.retryJob` / `promoteJob`): `retry` só de `failed`/`completed`,
 * `promote` só de `delayed`. Mostrar um botão que vai devolver 50 falhas com
 * "cannot_retry_job_in_state_waiting" seria pior que não mostrar.
 *
 * `remove` vale em qualquer estado — inclusive `active`, onde o BullMQ recusa se
 * o job estiver com lock; nesse caso o resultado parcial diz o motivo.
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
 * Barra que aparece quando há seleção. Três coisas que ela precisa dizer bem:
 *
 *  1. QUANTOS, e quantos estão fora da página visível. A tabela repolla a cada
 *     3 s: um id selecionado que saiu da página continua selecionado, e sumir
 *     com ele em silêncio seria trair o clique do operador.
 *  2. QUE CONJUNTO. Com uma busca na tela, "select all" pegou os RESULTADOS DA
 *     BUSCA carregados, não a fila toda. Dizer isso evita o erro caro.
 *  3. Remove em lote SEMPRE confirma (com o número e o nome da fila).
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
  /** estado exibido; define quais ações aparecem */
  state: JobState | "mixed";
  queue: string;
  /** override da lista de ações (a QueuePage já sabe o estado) */
  actions?: BulkJobAction[];
  onRun: (action: BulkJobAction) => void;
  pending?: BulkJobAction | null;
  /** true quando o que está na tela são resultados de busca, não a fila inteira */
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
 * O resultado parcial, mostrado como painel e não só como toast: "47 retried ·
 * 3 failed" com os motivos expansíveis. Um toast que desaparece em 4 s não
 * serve para o operador que precisa anotar quais 3 ids ficaram para trás.
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
