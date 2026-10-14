/**
 * The search box understands one filter besides plain text: `group:<id>` (or
 * `group:"id with spaces"`) keeps only that BullMQ Pro group's jobs. The rest is
 * the substring searched as before. Several `group:` tokens: the last one wins.
 */
export interface ParsedSearch {
  text: string;
  groupId?: string;
}

const GROUP_TOKEN = /(^|\s)group:(?:"([^"]+)"|(\S+))/g;

export function parseSearchQuery(raw: string): ParsedSearch {
  let groupId: string | undefined;
  const text = raw
    .replace(GROUP_TOKEN, (_m, lead: string, quoted?: string, bare?: string) => {
      groupId = quoted ?? bare;
      return lead;
    })
    .replace(/\s+/g, " ")
    .trim();
  return groupId ? { text, groupId } : { text };
}
