/** What the Cmd/Ctrl+K palette ranks: a title, plus text that should also match (connection name, email, synonyms). */
export interface Searchable {
  title: string;
  hint?: string;
  keywords?: string;
}

/**
 * 0 = no match. Every word of the query must appear somewhere (title, hint or
 * keywords), so "payments metrics" finds the payments queue's metrics tab.
 * Matches on the title outrank matches elsewhere; a lone word may also match
 * as a subsequence of the title ("pyc" → "payments.charge").
 */
export function scoreCommand(query: string, item: Searchable): number {
  const needle = query.trim().toLowerCase();
  if (!needle) return 1;
  const title = item.title.toLowerCase();
  if (title === needle) return 100;
  if (title.startsWith(needle)) return 80;
  if (title.split(/[\s.\-_/›:]+/).some((w) => w.startsWith(needle))) return 70;
  if (title.includes(needle)) return 60;

  const haystack = `${title} ${item.hint ?? ""} ${item.keywords ?? ""}`.toLowerCase();
  const words = needle.split(/\s+/);
  if (words.every((w) => haystack.includes(w))) return words.every((w) => title.includes(w)) ? 50 : 30;

  if (words.length > 1) return 0;
  let j = 0;
  for (let i = 0; i < title.length && j < needle.length; i++) if (title[i] === needle[j]) j++;
  return j === needle.length ? 10 : 0;
}
