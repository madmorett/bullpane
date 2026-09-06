import type { JobState } from "@bullmq-visualizer/shared";
import { cn } from "@/lib/cn";
import { formatCompact } from "@/lib/format";
import { chipStyle, stateColor, type ColoredState } from "@/lib/stateColors";
import { Badge } from "@/components/ui/Badge";

/**
 * Compatibility shim over src/lib/stateColors.ts for callers that only need a
 * label, a dot class or a raw colour. New code should import stateColors directly.
 */
export const STATE_META: Record<ColoredState, { label: string; dot: string; color: string; text: string }> = Object.fromEntries(
  (["waiting", "active", "completed", "failed", "delayed", "prioritized", "paused", "waiting-children", "unknown"] as ColoredState[]).map((s) => {
    const c = stateColor(s);
    return [s, { label: c.label, dot: c.dotClass, color: c.fg, text: c.textClass }];
  }),
) as Record<ColoredState, { label: string; dot: string; color: string; text: string }>;

export function StateBadge({ state, size, className }: { state: JobState | "unknown"; size?: "xs" | "sm"; className?: string }) {
  const c = stateColor(state);
  return (
    <Badge variant="custom" size={size} dot className={cn("border", className)} style={{ color: c.fg, background: c.bg, borderColor: c.border }}>
      {c.label}
    </Badge>
  );
}

/**
 * Coloured count chip, e.g. `completed 1.2K`. `muted` states render gray.
 * Use `hideZero` to drop the chip entirely when the count is 0.
 */
export function StateChip({
  state,
  count,
  hideZero,
  short,
  className,
  title,
}: {
  state: ColoredState;
  count: number;
  hideZero?: boolean;
  /** abbreviate the label (w-children → children) */
  short?: boolean;
  className?: string;
  title?: string;
}) {
  if (hideZero && !count) return null;
  const c = stateColor(state);
  const label = short && state === "waiting-children" ? "children" : c.label;
  return (
    <span className={cn("state-chip", c.muted && "muted", className)} style={c.muted ? undefined : chipStyle(state)} title={title ?? `${formatCompact(count)} ${c.label}`}>
      <span className="opacity-80">{label}</span>
      <span className="num font-semibold">{formatCompact(count)}</span>
    </span>
  );
}
