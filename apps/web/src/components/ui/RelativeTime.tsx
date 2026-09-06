import { cn } from "@/lib/cn";
import { formatDateTime, formatRelative, toMs } from "@/lib/format";
import { useNow } from "@/lib/useNow";

export interface RelativeTimeProps {
  value: number | string | Date | null | undefined;
  className?: string;
  /** show the absolute time next to the relative one */
  withAbsolute?: boolean;
  emptyText?: string;
}

/** "3m ago" with the absolute timestamp on hover. */
export function RelativeTime({ value, className, withAbsolute, emptyText = "–" }: RelativeTimeProps) {
  const now = useNow();
  const ms = toMs(value);
  if (ms == null) return <span className={cn("text-fg-subtle", className)}>{emptyText}</span>;
  const abs = formatDateTime(ms);
  return (
    <time dateTime={new Date(ms).toISOString()} title={abs} className={cn("num whitespace-nowrap", className)}>
      {formatRelative(ms, now)}
      {withAbsolute && <span className="ml-1.5 text-fg-subtle">{abs}</span>}
    </time>
  );
}
