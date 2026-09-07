import { Link } from "react-router-dom";
import type { JobState } from "@bullpane/shared";
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
 *
 * `to` turns the chip into a deep link to that state. It matters on the queue
 * card, which is covered by a stretched link overlay (`after:absolute
 * after:inset-0`): a plain `<span>` there is unclickable, so a chip with `to`
 * gets `relative z-10` to sit ABOVE the overlay — the same trick the search icon
 * on the card already used.
 */
export function StateChip({
  state,
  count,
  hideZero,
  short,
  className,
  title,
  to,
}: {
  state: ColoredState;
  count: number;
  hideZero?: boolean;
  /** abbreviate the label (w-children → children) */
  short?: boolean;
  className?: string;
  title?: string;
  /** deep link to this state; renders the chip as a link above any card overlay */
  to?: string;
}) {
  if (hideZero && !count) return null;
  const c = stateColor(state);
  const label = short && state === "waiting-children" ? "children" : c.label;
  const body = (
    <>
      <span className="opacity-80">{label}</span>
      <span className="num font-semibold">{formatCompact(count)}</span>
    </>
  );
  const style = c.muted ? undefined : chipStyle(state);
  const tip = title ?? `${formatCompact(count)} ${c.label}`;
  if (to) {
    return (
      <Link
        to={to}
        className={cn("state-chip relative z-10 hover:brightness-125 hover:underline", c.muted && "muted", className)}
        style={style}
        title={`${tip} — open the ${c.label} tab`}
      >
        {body}
      </Link>
    );
  }
  return (
    <span className={cn("state-chip", c.muted && "muted", className)} style={style} title={tip}>
      {body}
    </span>
  );
}
