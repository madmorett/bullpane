import { useCallback, useMemo, useRef, useState } from "react";

/**
 * Seleção de jobs numa tabela que se recarrega a cada 3 s.
 *
 * A decisão que faz isto funcionar: a seleção é guardada por **jobId**, nunca
 * por índice. A tabela repolla e as linhas trocam de posição (é a causa dos
 * erros de alvo que já existem hoje); um índice guardado aponta para outro job
 * no ciclo seguinte, e o operador remove o job errado.
 *
 * A segunda decisão: um id selecionado que SAIU da página visível continua
 * selecionado. Descartá-lo em silêncio seria pior que qualquer alternativa —
 * o operador clicou nele. A UI mostra "3 selected (2 not on this page)" e
 * `visibleSelected` vs `selectedIds` deixa as duas contagens disponíveis.
 */
export interface JobSelection {
  /** todos os ids selecionados, inclusive os que não estão na página atual */
  selectedIds: string[];
  /** quantos ids selecionados estão na página visível agora */
  visibleSelectedCount: number;
  /** ids selecionados que não estão na lista visível (saíram com o polling/paginação) */
  offPageCount: number;
  /** true quando TODA a página visível está selecionada (e a página não é vazia) */
  allVisibleSelected: boolean;
  has(jobId: string): boolean;
  toggle(jobId: string): void;
  /** Shift+clique: seleciona/limpa o intervalo entre a última âncora e este id */
  toggleRange(jobId: string): void;
  /** marca ou desmarca a página visível inteira, sem tocar no que está fora dela */
  toggleAllVisible(): void;
  clear(): void;
  /** remove ids da seleção (usado depois de uma ação bem-sucedida) */
  deselect(jobIds: string[]): void;
}

/**
 * A matemática da seleção, extraída como funções PURAS.
 *
 * Motivo: o valor destas regras está no comportamento sob polling (ids que
 * saem da página, âncora que desaparece, intervalo que inverte o sentido) e isso
 * merece teste. Testar isso através de um hook exigiria um DOM; como funções
 * puras, cabe num teste de node.
 */

/** Marca ou desmarca um id. */
export function applyToggle(selected: ReadonlySet<string>, jobId: string): Set<string> {
  const next = new Set(selected);
  if (next.has(jobId)) next.delete(jobId);
  else next.add(jobId);
  return next;
}

/**
 * Shift+clique: aplica o intervalo entre a âncora e `jobId` DENTRO da página
 * visível. Se a âncora não está mais visível (o polling a tirou da página),
 * degrada para um clique simples em vez de adivinhar um intervalo.
 *
 * O sentido segue o id clicado: clicar num desmarcado marca o intervalo,
 * clicar num marcado limpa o intervalo.
 */
export function applyRange(
  selected: ReadonlySet<string>,
  visibleIds: readonly string[],
  anchorId: string | null,
  jobId: string,
): Set<string> {
  const start = anchorId ? visibleIds.indexOf(anchorId) : -1;
  const end = visibleIds.indexOf(jobId);
  if (start < 0 || end < 0) return applyToggle(selected, jobId);
  const [lo, hi] = start <= end ? [start, end] : [end, start];
  const selecting = !selected.has(jobId);
  const next = new Set(selected);
  for (const id of visibleIds.slice(lo, hi + 1)) {
    if (selecting) next.add(id);
    else next.delete(id);
  }
  return next;
}

/**
 * Cabeçalho: marca a página visível inteira, ou a limpa se já estava toda
 * marcada. NUNCA toca nos ids selecionados que estão fora da página — quem
 * clicou neles clicou de propósito.
 */
export function applyToggleAllVisible(selected: ReadonlySet<string>, visibleIds: readonly string[]): Set<string> {
  const all = visibleIds.length > 0 && visibleIds.every((id) => selected.has(id));
  const next = new Set(selected);
  for (const id of visibleIds) {
    if (all) next.delete(id);
    else next.add(id);
  }
  return next;
}

/** Quantos ids selecionados estão na página visível agora. */
export function countVisibleSelected(selected: ReadonlySet<string>, visibleIds: readonly string[]): number {
  return visibleIds.reduce((n, id) => (selected.has(id) ? n + 1 : n), 0);
}

export function useJobSelection(visibleIds: string[]): JobSelection {
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
  /** último id clicado, âncora do Shift+clique */
  const anchor = useRef<string | null>(null);

  const has = useCallback((jobId: string) => selected.has(jobId), [selected]);

  const toggle = useCallback((jobId: string) => {
    anchor.current = jobId;
    setSelected((prev) => applyToggle(prev, jobId));
  }, []);

  const toggleRange = useCallback(
    (jobId: string) => {
      const from = anchor.current;
      anchor.current = jobId;
      setSelected((prev) => applyRange(prev, visibleIds, from, jobId));
    },
    [visibleIds],
  );

  const visibleSelectedCount = useMemo(() => countVisibleSelected(selected, visibleIds), [visibleIds, selected]);
  const allVisibleSelected = visibleIds.length > 0 && visibleSelectedCount === visibleIds.length;

  const toggleAllVisible = useCallback(() => {
    setSelected((prev) => applyToggleAllVisible(prev, visibleIds));
    anchor.current = null;
  }, [visibleIds]);

  const clear = useCallback(() => {
    setSelected(new Set());
    anchor.current = null;
  }, []);

  const deselect = useCallback((jobIds: string[]) => {
    setSelected((prev) => {
      const next = new Set(prev);
      for (const id of jobIds) next.delete(id);
      return next;
    });
  }, []);

  const selectedIds = useMemo(() => [...selected], [selected]);

  return {
    selectedIds,
    visibleSelectedCount,
    offPageCount: selectedIds.length - visibleSelectedCount,
    allVisibleSelected,
    has,
    toggle,
    toggleRange,
    toggleAllVisible,
    clear,
    deselect,
  };
}
