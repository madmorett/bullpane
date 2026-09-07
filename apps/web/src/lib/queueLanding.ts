import type { JobState, QueueCounts } from "@bullmq-visualizer/shared";

/**
 * Para qual estado um clique numa fila deve levar.
 *
 * O problema que isto resolve: todo ponto de entrada (card, linha da tabela,
 * sidebar) mostrava um contador vermelho de `failed` e nenhum levava até lá —
 * `routes.queue()` era chamado sem `state` e a QueuePage caía em `waiting`.
 * Você clicava numa fila com 1.000 falhas e lia "No jobs in this state". Um
 * clique desperdiçado em 100% dos incidentes.
 *
 * A regra, em ordem:
 *   1. `failed > 0`  → `failed`. Se há falhas, é por elas que o operador veio.
 *   2. `waiting > 0` → `waiting`. Sem falhas, o que importa é a fila de entrada.
 *   3. senão         → `completed`. Fila saudável e vazia: mostra o histórico,
 *                      que é a única aba com conteúdo. Cair em `waiting` aqui
 *                      significa cair numa tabela vazia.
 *
 * `prioritized` conta como espera (é a fila de entrada com prioridade), mas o
 * destino continua sendo `waiting`, que é a aba que o operador procura; um
 * `waiting: 0 / prioritized: 5` manda para `prioritized`, senão o clique cairia
 * numa tabela vazia de novo.
 *
 * Função pura de propósito: é o coração da correção e tem teste próprio.
 */
export function queueLandingState(counts: Partial<QueueCounts> | undefined): JobState {
  const failed = counts?.failed ?? 0;
  if (failed > 0) return "failed";
  const waiting = counts?.waiting ?? 0;
  if (waiting > 0) return "waiting";
  const prioritized = counts?.prioritized ?? 0;
  if (prioritized > 0) return "prioritized";
  return "completed";
}
