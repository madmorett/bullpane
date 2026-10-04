/** `payments-*` -> /^payments-.*$/ ; `?` matches one char. Used by every inspector's queueFilter. */
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
