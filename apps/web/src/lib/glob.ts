/**
 * Tiny glob matcher for queue-name patterns (`channels*`, `*-retry`, `job-?`).
 *
 * Deliberately NOT imported from the redis inspector package: this one only
 * ever runs against names already loaded in the browser, and the two have
 * different jobs — the inspector filters discovery server-side, this one
 * previews an import for a human. Only `*` (any run, including empty) and `?`
 * (exactly one char) are special; everything else is a literal. Case-insensitive.
 */
export function globToRegExp(pattern: string): RegExp {
  let out = "";
  for (const ch of pattern) {
    if (ch === "*") out += ".*";
    else if (ch === "?") out += ".";
    else out += ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${out}$`, "i");
}

/** true when `pattern` is non-empty and matches `name` under glob semantics. */
export function globMatches(pattern: string, name: string): boolean {
  const p = pattern.trim();
  if (!p) return false;
  try {
    return globToRegExp(p).test(name);
  } catch {
    return false;
  }
}
