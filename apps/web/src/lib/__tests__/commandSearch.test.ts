import { describe, expect, it } from "vitest";
import { scoreCommand } from "../commandSearch";

describe("scoreCommand", () => {
  const queue = { title: "payments.charge", hint: "Demo Redis" };

  it("matches everything on an empty query", () => {
    expect(scoreCommand("  ", queue)).toBe(1);
  });

  it("ranks exact > prefix > word start > substring on the title", () => {
    const exact = scoreCommand("payments.charge", queue);
    const prefix = scoreCommand("pay", queue);
    const word = scoreCommand("char", queue);
    const sub = scoreCommand("harg", queue);
    expect(exact).toBeGreaterThan(prefix);
    expect(prefix).toBeGreaterThan(word);
    expect(word).toBeGreaterThan(sub);
  });

  it("needs every word, anywhere, and prefers them in the title", () => {
    const tab = { title: "payments.charge › Metrics", keywords: "charts throughput" };
    expect(scoreCommand("payments metrics", tab)).toBe(50);
    expect(scoreCommand("charge throughput", tab)).toBe(30);
    expect(scoreCommand("payments alerts", tab)).toBe(0);
  });

  it("matches hint and keywords below the title", () => {
    expect(scoreCommand("demo", queue)).toBe(30);
    expect(scoreCommand("dark", { title: "Theme: Dark", keywords: "appearance" })).toBeGreaterThan(scoreCommand("appearance", { title: "Theme: Dark", keywords: "appearance" }));
  });

  it("falls back to a subsequence of the title for one word", () => {
    expect(scoreCommand("pyc", queue)).toBe(10);
    expect(scoreCommand("zzz", queue)).toBe(0);
  });
});
