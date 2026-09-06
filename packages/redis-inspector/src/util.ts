/** Small pure helpers shared by the inspector. No Redis here. */

/**
 * Convert a simple glob (`*` and `?` only) into an anchored RegExp.
 * Everything else is escaped, so `payments-*` never becomes a regex surprise.
 */
export function globToRegExp(glob: string): RegExp {
  const escaped = glob
    .split("")
    .map((ch) => {
      if (ch === "*") return ".*";
      if (ch === "?") return ".";
      return ch.replace(/[.+^${}()|[\]\\/]/g, "\\$&");
    })
    .join("");
  return new RegExp(`^${escaped}$`);
}

/** JSON.parse that never throws: returns `fallback` (default: the raw string) on bad input. */
export function safeJsonParse(raw: string | null | undefined, fallback?: unknown): unknown {
  if (raw === null || raw === undefined) return fallback === undefined ? null : fallback;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return fallback === undefined ? raw : fallback;
  }
}

/** parseInt that yields `fallback` for null/NaN. */
export function toInt(raw: string | number | null | undefined, fallback: number): number {
  if (raw === null || raw === undefined || raw === "") return fallback;
  const n = typeof raw === "number" ? raw : parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}

/** toInt but null instead of a fallback number. */
export function toIntOrNull(raw: string | number | null | undefined): number | null {
  if (raw === null || raw === undefined || raw === "") return null;
  const n = typeof raw === "number" ? raw : parseInt(raw, 10);
  return Number.isFinite(n) ? n : null;
}

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Parse the `INFO` command output into a flat `field -> value` map (sections are ignored). */
export function toFloatOrNull(raw: string | number | null | undefined): number | null {
  if (raw === null || raw === undefined || raw === "") return null;
  const n = typeof raw === "number" ? raw : Number.parseFloat(raw);
  return Number.isFinite(n) ? n : null;
}

export function parseRedisInfo(info: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of info.split(/\r?\n/)) {
    if (!line || line.startsWith("#")) continue;
    const i = line.indexOf(":");
    if (i === -1) continue;
    out[line.slice(0, i)] = line.slice(i + 1);
  }
  return out;
}

/** `db0:keys=12,expires=0,avg_ttl=0` lines -> total keys across databases. */
export function totalKeysFromInfo(info: Record<string, string>): number | null {
  let total = 0;
  let seen = false;
  for (const [k, v] of Object.entries(info)) {
    if (!/^db\d+$/.test(k)) continue;
    const m = /keys=(\d+)/.exec(v);
    if (m) {
      total += parseInt(m[1], 10);
      seen = true;
    }
  }
  return seen ? total : null;
}

/** Error message of anything thrown. */
export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
