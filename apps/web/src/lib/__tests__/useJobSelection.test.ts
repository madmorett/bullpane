/**
 * A matemática da seleção. O que importa aqui não é marcar uma caixinha — é o
 * comportamento quando a tabela repolla (a cada 3 s) e as linhas mudam de lugar:
 * a seleção é por jobId, ids que saem da página continuam selecionados, e
 * "select all" nunca toca no que está fora da página visível.
 */
import { describe, expect, it } from "vitest";
import { applyRange, applyToggle, applyToggleAllVisible, countVisibleSelected } from "../useJobSelection";

const set = (...ids: string[]) => new Set(ids);
const sorted = (s: Set<string>) => [...s].sort();

describe("applyToggle", () => {
  it("marca e desmarca", () => {
    expect(sorted(applyToggle(set(), "a"))).toEqual(["a"]);
    expect(sorted(applyToggle(set("a", "b"), "a"))).toEqual(["b"]);
  });

  it("não muta o conjunto anterior (React precisa de uma referência nova)", () => {
    const before = set("a");
    const after = applyToggle(before, "b");
    expect(sorted(before)).toEqual(["a"]);
    expect(after).not.toBe(before);
  });
});

describe("applyRange (Shift+clique)", () => {
  const page = ["1", "2", "3", "4", "5"];

  it("marca o intervalo entre a âncora e o id clicado", () => {
    expect(sorted(applyRange(set("2"), page, "2", "4"))).toEqual(["2", "3", "4"]);
  });

  it("funciona de baixo para cima", () => {
    expect(sorted(applyRange(set("4"), page, "4", "2"))).toEqual(["2", "3", "4"]);
  });

  it("clicar num id JÁ marcado limpa o intervalo em vez de marcar", () => {
    const all = set(...page);
    expect(sorted(applyRange(all, page, "2", "4"))).toEqual(["1", "5"]);
  });

  it("sem âncora, degrada para um clique simples", () => {
    expect(sorted(applyRange(set(), page, null, "3"))).toEqual(["3"]);
  });

  it("âncora que saiu da página no polling degrada para clique simples, não inventa intervalo", () => {
    // Este é o caso real: o job âncora foi processado e saiu da lista entre
    // dois ciclos de polling. Adivinhar um intervalo aqui selecionaria jobs
    // que o operador nunca viu.
    expect(sorted(applyRange(set(), page, "999", "3"))).toEqual(["3"]);
  });

  it("preserva ids selecionados que estão fora da página visível", () => {
    const withOffPage = set("off-1");
    expect(sorted(applyRange(withOffPage, page, "1", "2"))).toEqual(["1", "2", "off-1"]);
  });
});

describe("applyToggleAllVisible", () => {
  const page = ["1", "2", "3"];

  it("marca a página inteira quando nada está marcado", () => {
    expect(sorted(applyToggleAllVisible(set(), page))).toEqual(["1", "2", "3"]);
  });

  it("marca a página inteira quando só parte estava marcada", () => {
    expect(sorted(applyToggleAllVisible(set("2"), page))).toEqual(["1", "2", "3"]);
  });

  it("limpa a página quando ela toda estava marcada", () => {
    expect(sorted(applyToggleAllVisible(set("1", "2", "3"), page))).toEqual([]);
  });

  it("NUNCA descarta ids fora da página — quem clicou neles clicou de propósito", () => {
    // Marcar a página: os de fora ficam.
    expect(sorted(applyToggleAllVisible(set("off-1"), page))).toEqual(["1", "2", "3", "off-1"]);
    // Limpar a página: os de fora TAMBÉM ficam.
    expect(sorted(applyToggleAllVisible(set("1", "2", "3", "off-1"), page))).toEqual(["off-1"]);
  });

  it("página vazia é um no-op", () => {
    expect(sorted(applyToggleAllVisible(set("off-1"), []))).toEqual(["off-1"]);
  });
});

describe("countVisibleSelected (a base de \"3 selected (2 not on this page)\")", () => {
  it("conta só o que está na página visível", () => {
    const selected = set("1", "3", "off-1", "off-2");
    const page = ["1", "2", "3"];
    expect(countVisibleSelected(selected, page)).toBe(2);
    // e a diferença é exatamente o que a barra mostra entre parênteses
    expect(selected.size - countVisibleSelected(selected, page)).toBe(2);
  });

  it("a seleção sobrevive à página inteira sendo trocada pelo polling", () => {
    const selected = set("10", "11", "12");
    // ciclo 1: os três estão visíveis
    expect(countVisibleSelected(selected, ["10", "11", "12", "13"])).toBe(3);
    // ciclo 2: a fila andou e os três saíram da primeira página
    expect(countVisibleSelected(selected, ["20", "21", "22"])).toBe(0);
    // mas continuam selecionados: nada foi descartado em silêncio
    expect(selected.size).toBe(3);
  });
});
