import type { JobState } from "@bullmq-visualizer/shared";
import type { CSSProperties } from "react";

/**
 * The ONE place job states get a colour. bull-board convention:
 * completed green · active blue · waiting amber · delayed purple · failed red,
 * everything else muted gray. The raw values live as CSS vars in styles.css
 * (dark + light); this module only hands out references to them.
 */
export type ColoredState = JobState | "unknown";

export interface StateColor {
  /** human label */
  label: string;
  /** solid colour, e.g. text / dots / strokes */
  fg: string;
  /** translucent fill for chips and badges */
  bg: string;
  /** translucent border for chips */
  border: string;
  /** Tailwind class for a solid dot / bar (`bg-state-*`) — full string so Tailwind sees it */
  dotClass: string;
  /** Tailwind class for text in this colour */
  textClass: string;
  /** true for the gray "secondary" states */
  muted: boolean;
}

function build(state: ColoredState, label: string, muted = false): StateColor {
  const v = `var(--state-${state})`;
  return {
    label,
    fg: v,
    bg: `color-mix(in srgb, ${v} 14%, transparent)`,
    border: `color-mix(in srgb, ${v} 38%, transparent)`,
    dotClass: DOT_CLASS[state],
    textClass: TEXT_CLASS[state],
    muted,
  };
}

// Written out in full (not templated) so Tailwind's scanner picks them up.
const DOT_CLASS: Record<ColoredState, string> = {
  completed: "bg-state-completed",
  active: "bg-state-active",
  waiting: "bg-state-waiting",
  delayed: "bg-state-delayed",
  failed: "bg-state-failed",
  prioritized: "bg-state-prioritized",
  paused: "bg-state-paused",
  "waiting-children": "bg-state-waiting-children",
  unknown: "bg-state-unknown",
};
const TEXT_CLASS: Record<ColoredState, string> = {
  completed: "text-state-completed",
  active: "text-state-active",
  waiting: "text-state-waiting",
  delayed: "text-state-delayed",
  failed: "text-state-failed",
  prioritized: "text-state-prioritized",
  paused: "text-state-paused",
  "waiting-children": "text-state-waiting-children",
  unknown: "text-state-unknown",
};

export const STATE_COLORS: Record<ColoredState, StateColor> = {
  completed: build("completed", "completed"),
  active: build("active", "active"),
  waiting: build("waiting", "waiting"),
  delayed: build("delayed", "delayed"),
  failed: build("failed", "failed"),
  prioritized: build("prioritized", "prioritized", true),
  paused: build("paused", "paused", true),
  "waiting-children": build("waiting-children", "waiting-children", true),
  unknown: build("unknown", "unknown", true),
};

export function stateColor(state: string | null | undefined): StateColor {
  return (state && (STATE_COLORS as Record<string, StateColor>)[state]) || STATE_COLORS.unknown;
}

/** Inline CSS vars consumed by the `.state-chip` class. */
export function chipStyle(state: ColoredState): CSSProperties {
  const c = stateColor(state);
  return { "--chip-fg": c.fg, "--chip-bg": c.bg, "--chip-border": c.border } as CSSProperties;
}

/** Order in which the "primary" states appear on cards / strips. */
export const PRIMARY_STATES: readonly JobState[] = ["completed", "active", "waiting", "delayed", "failed"] as const;
/** Gray states shown only when non-zero. */
export const SECONDARY_STATES: readonly JobState[] = ["prioritized", "paused", "waiting-children"] as const;
