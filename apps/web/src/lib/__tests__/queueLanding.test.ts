/**
 * A regra de destino de um clique numa fila. É uma função pura por um motivo:
 * é a correção inteira da tarefa 1 e não deveria depender de renderizar nada
 * para ser verificada.
 */
import { describe, expect, it } from "vitest";
import type { QueueCounts } from "@bullmq-visualizer/shared";
import { queueLandingState } from "../queueLanding";

const counts = (patch: Partial<QueueCounts>): QueueCounts => ({
  waiting: 0,
  active: 0,
  completed: 0,
  failed: 0,
  delayed: 0,
  prioritized: 0,
  paused: 0,
  "waiting-children": 0,
  ...patch,
});

describe("queueLandingState", () => {
  it("manda para failed quando há qualquer falha", () => {
    expect(queueLandingState(counts({ failed: 1 }))).toBe("failed");
    expect(queueLandingState(counts({ failed: 1000, waiting: 60, completed: 50_000 }))).toBe("failed");
  });

  it("failed ganha de waiting — é por isso que o operador clicou", () => {
    // O caso do incidente: 22 falhas atrás de 60 esperando. Cair em waiting
    // esconde exatamente o que o contador vermelho estava anunciando.
    expect(queueLandingState(counts({ waiting: 60, failed: 22 }))).toBe("failed");
  });

  it("sem falhas, manda para waiting", () => {
    expect(queueLandingState(counts({ waiting: 5 }))).toBe("waiting");
    expect(queueLandingState(counts({ waiting: 5, completed: 900, active: 3 }))).toBe("waiting");
  });

  it("sem falhas e sem waiting, cai em prioritized se for lá que os jobs estão", () => {
    // prioritized É fila de entrada; mandar para waiting aqui daria tabela vazia.
    expect(queueLandingState(counts({ prioritized: 7 }))).toBe("prioritized");
  });

  it("fila saudável e vazia cai em completed, a única aba com conteúdo", () => {
    expect(queueLandingState(counts({ completed: 500 }))).toBe("completed");
    expect(queueLandingState(counts({ active: 2, completed: 500 }))).toBe("completed");
  });

  it("fila totalmente vazia cai em completed, não numa aba pior", () => {
    expect(queueLandingState(counts({}))).toBe("completed");
  });

  it("não explode sem contagens (fila cujo stats falhou)", () => {
    expect(queueLandingState(undefined)).toBe("completed");
    expect(queueLandingState({})).toBe("completed");
  });

  it("delayed / paused / waiting-children não desviam o destino", () => {
    // São estados reais, mas nenhum é o motivo de alguém abrir uma fila às 3h.
    expect(queueLandingState(counts({ delayed: 40 }))).toBe("completed");
    expect(queueLandingState(counts({ paused: 40 }))).toBe("completed");
    expect(queueLandingState(counts({ "waiting-children": 40 }))).toBe("completed");
    expect(queueLandingState(counts({ delayed: 40, failed: 1 }))).toBe("failed");
  });
});
