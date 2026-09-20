/**
 * localStorage that never throws (private windows, disabled storage, quota).
 * Keys are namespaced with `bullpane.` to match the sidebar's existing entries.
 */
const PREFIX = "bullpane.";

export function readStorage<T>(key: string, fallback: T, parse: (raw: string) => T | undefined = defaultParse): T {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    if (raw == null) return fallback;
    const v = parse(raw);
    return v === undefined ? fallback : v;
  } catch {
    return fallback;
  }
}

export function writeStorage(key: string, value: unknown): void {
  try {
    if (value === undefined || value === null) localStorage.removeItem(PREFIX + key);
    else localStorage.setItem(PREFIX + key, typeof value === "string" ? value : JSON.stringify(value));
  } catch {
    /* ignore */
  }
}

function defaultParse<T>(raw: string): T | undefined {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return raw as unknown as T;
  }
}
