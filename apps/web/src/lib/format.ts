const numberFormat = new Intl.NumberFormat("en-US");
const compactFormat = new Intl.NumberFormat("en-US", {
  notation: "compact",
  maximumFractionDigits: 1,
});

export function formatNumber(n: number | null | undefined): string {
  if (n == null || Number.isNaN(n)) return "–";
  return numberFormat.format(n);
}

export function formatCompact(n: number | null | undefined): string {
  if (n == null || Number.isNaN(n)) return "–";
  if (Math.abs(n) < 10_000) return numberFormat.format(n);
  return compactFormat.format(n);
}

export function formatPercent(n: number | null | undefined, digits = 1): string {
  if (n == null || Number.isNaN(n)) return "–";
  return `${n.toFixed(digits)}%`;
}

export function formatBytes(bytes: number | null | undefined): string {
  if (bytes == null || Number.isNaN(bytes)) return "–";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB", "PB"];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 100 ? 0 : v >= 10 ? 1 : 2)} ${units[i]}`;
}

/** Human duration from milliseconds: 450ms, 1.25s, 3m 4s, 2h 5m, 3d 2h */
export function formatDuration(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return "–";
  if (ms < 0) ms = 0;
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(s < 10 ? 2 : 1)}s`;
  const m = Math.floor(s / 60);
  const rs = Math.round(s % 60);
  if (m < 60) return `${m}m ${rs}s`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  if (h < 24) return `${h}h ${rm}m`;
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}h`;
}

export function formatUptime(seconds: number | null | undefined): string {
  if (seconds == null) return "–";
  return formatDuration(seconds * 1000);
}

export function toMs(ts: number | string | Date | null | undefined): number | null {
  if (ts == null || ts === "") return null;
  if (ts instanceof Date) return ts.getTime();
  if (typeof ts === "number") return Number.isFinite(ts) && ts > 0 ? ts : null;
  const n = Number(ts);
  if (!Number.isNaN(n) && n > 0) return n;
  const parsed = Date.parse(ts);
  return Number.isNaN(parsed) ? null : parsed;
}

export function formatRelative(
  ts: number | string | Date | null | undefined,
  now: number = Date.now(),
): string {
  const t = toMs(ts);
  if (t == null) return "–";
  const diff = now - t;
  const future = diff < 0;
  const abs = Math.abs(diff);
  const s = Math.round(abs / 1000);
  let text: string;
  if (s < 5) return "just now";
  else if (s < 60) text = `${s}s`;
  else if (s < 3600) text = `${Math.floor(s / 60)}m`;
  else if (s < 86_400) text = `${Math.floor(s / 3600)}h`;
  else if (s < 86_400 * 30) text = `${Math.floor(s / 86_400)}d`;
  else return formatDate(t);
  return future ? `in ${text}` : `${text} ago`;
}

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

export function formatDate(ts: number | string | Date | null | undefined): string {
  const t = toMs(ts);
  if (t == null) return "–";
  const d = new Date(t);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function formatDateTime(ts: number | string | Date | null | undefined): string {
  const t = toMs(ts);
  if (t == null) return "–";
  const d = new Date(t);
  return `${formatDate(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export function formatDateTimeMs(ts: number | string | Date | null | undefined): string {
  const t = toMs(ts);
  if (t == null) return "–";
  const d = new Date(t);
  return `${formatDateTime(d)}.${String(d.getMilliseconds()).padStart(3, "0")}`;
}

export function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, Math.max(0, max - 1))}…`;
}

export function pluralize(n: number, word: string, plural = `${word}s`): string {
  return `${formatNumber(n)} ${n === 1 ? word : plural}`;
}

export function safeJsonStringify(value: unknown, space = 2): string {
  try {
    if (typeof value === "string") return value;
    return JSON.stringify(value, null, space) ?? String(value);
  } catch {
    return String(value);
  }
}

/** Try to pretty print a string that may contain JSON. Returns null when it is not JSON. */
export function tryPrettyJson(text: string): string | null {
  try {
    const v = JSON.parse(text);
    return JSON.stringify(v, null, 2);
  } catch {
    return null;
  }
}

export function formatQueueKey(prefix: string, queue: string): string {
  return `${prefix}:${queue}`;
}

/**
 * CPU cores burned by a process. 1.0 = one core saturated.
 * Null (first sample, or after a Redis restart reset the counter) is NOT zero.
 */
export function formatCores(cores: number | null | undefined): string {
  if (cores == null || !Number.isFinite(cores)) return "–";
  if (cores >= 10) return `${cores.toFixed(1)} cores`;
  return `${cores.toFixed(2)} ${cores === 1 ? "core" : "cores"}`;
}

/**
 * CPU as a percentage of ONE core, which is the number that means something for
 * a mostly single-threaded Redis: 100% = one saturated core. Above 100% is real
 * and legitimate (background threads), so it is never clamped.
 * Null stays an em dash — a rate needs two samples, and "no reading" is not 0%.
 */
export function formatCpuPercent(cores: number | null | undefined): string {
  if (cores == null || !Number.isFinite(cores)) return "–";
  const pct = cores * 100;
  if (pct >= 10) return `${Math.round(pct)}%`;
  if (pct >= 1) return `${pct.toFixed(0)}%`;
  return `${pct.toFixed(pct >= 0.1 ? 1 : 2)}%`;
}

/** A per-second rate, e.g. "12.4k/s". Null renders as an em dash, never 0. */
export function formatRate(n: number | null | undefined, unit = "/s"): string {
  if (n == null || !Number.isFinite(n)) return "–";
  if (n >= 10_000) return `${compactFormat.format(n)}${unit}`;
  if (n >= 100) return `${Math.round(n)}${unit}`;
  return `${n.toFixed(n < 10 ? 2 : 1)}${unit}`;
}

/** Milliseconds as a latency reading: 0.8 ms, 12 ms, 1.2 s */
export function formatLatency(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return "–";
  if (ms >= 1000) return `${(ms / 1000).toFixed(2)} s`;
  if (ms >= 10) return `${Math.round(ms)} ms`;
  return `${ms.toFixed(1)} ms`;
}

/** A ratio like mem_fragmentation_ratio: "1.42×" */
export function formatRatio(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "–";
  return `${n.toFixed(2)}×`;
}
