/**
 * The smallest thing that can run a smoke: named checks grouped in sections,
 * a PASS/FAIL line per check, and a summary that sets the exit code.
 *
 * A failing check does not stop the run (the next ones still tell you
 * something), except when it throws `Abort`: then the section stops.
 */
import { setTimeout as sleep } from "node:timers/promises";

export class Abort extends Error {}

interface Result {
  section: string;
  name: string;
  ok: boolean;
  ms: number;
  detail?: string;
}

const results: Result[] = [];
let section = "";

const color = (code: number, s: string) => (process.stdout.isTTY ? `\x1b[${code}m${s}\x1b[0m` : s);
export const green = (s: string) => color(32, s);
export const red = (s: string) => color(31, s);
export const dim = (s: string) => color(2, s);
export const bold = (s: string) => color(1, s);

export function heading(name: string): void {
  section = name;
  console.log(`\n${bold(name)}`);
}

export function info(line: string): void {
  console.log(`  ${dim(line)}`);
}

/** Run one check. Returns its value, or undefined when it failed. */
export async function check<T>(name: string, fn: () => Promise<T> | T): Promise<T | undefined> {
  const t0 = performance.now();
  try {
    const value = await fn();
    const ms = performance.now() - t0;
    results.push({ section, name, ok: true, ms });
    console.log(`  ${green("PASS")} ${name} ${dim(`${ms.toFixed(0)} ms`)}`);
    return value;
  } catch (err) {
    const ms = performance.now() - t0;
    const detail = err instanceof Error ? err.message : String(err);
    results.push({ section, name, ok: false, ms, detail });
    console.log(`  ${red("FAIL")} ${name} ${dim(`${ms.toFixed(0)} ms`)}\n       ${red(detail)}`);
    if (err instanceof Abort) throw err;
    return undefined;
  }
}

export function assert(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(message);
}

export function eq<T>(actual: T, expected: T, what: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${what}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

export async function waitFor<T>(what: string, fn: () => Promise<T | null | undefined | false>, ms = 20_000, every = 100): Promise<T> {
  const deadline = Date.now() + ms;
  let last: unknown = null;
  while (Date.now() < deadline) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (err) {
      last = err;
    }
    await sleep(every);
  }
  throw new Error(`timed out waiting for ${what}${last ? ` (last error: ${last instanceof Error ? last.message : String(last)})` : ""}`);
}

export function percentile(values: number[], p: number): number {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)]!;
}

/** Prints the summary and returns the process exit code. */
export function summary(): number {
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${bold("Summary")}`);
  const bySection = new Map<string, { ok: number; fail: number }>();
  for (const r of results) {
    const s = bySection.get(r.section) ?? { ok: 0, fail: 0 };
    if (r.ok) s.ok += 1;
    else s.fail += 1;
    bySection.set(r.section, s);
  }
  for (const [name, s] of bySection) {
    console.log(`  ${s.fail === 0 ? green("✓") : red("✗")} ${name}: ${s.ok} passed${s.fail ? `, ${red(`${s.fail} failed`)}` : ""}`);
  }
  console.log(`\n  ${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) {
    console.log(red("\n  Failed:"));
    for (const f of failed) console.log(red(`   - [${f.section}] ${f.name}: ${f.detail}`));
  }
  return failed.length === 0 ? 0 : 1;
}
