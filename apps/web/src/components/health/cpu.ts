import { formatCores } from "@/lib/format";

/**
 * Redis runs its command loop on a single thread, so every CPU reading in the
 * dashboard is measured against ONE core: 100% is the practical ceiling of the
 * thread that actually moves jobs. Above 100% is real and legitimate (Redis has
 * background threads for persistence and lazy free), so nothing is clamped
 * except the width of the meter, which cannot exceed its own track.
 *
 * The thresholds live here, once, so the strip, the card and any future surface
 * cannot drift apart about what "hot" means.
 */
const DANGER = 0.9;
const WARN = 0.7;

/** Tone for text: undefined when there is nothing to flag. */
export function cpuWarnTone(cores: number | null | undefined): "warn" | "danger" | undefined {
  if (cores == null || !Number.isFinite(cores)) return undefined;
  if (cores >= DANGER) return "danger";
  if (cores >= WARN) return "warn";
  return undefined;
}

/** Tone for the progress meter, which always needs a concrete value. */
export function cpuMeterTone(cores: number | null | undefined): "ok" | "warn" | "danger" {
  return cpuWarnTone(cores) ?? "ok";
}

export function cpuTooltip(cores: number | null | undefined): string {
  if (cores == null || !Number.isFinite(cores))
    return "No CPU rate yet — needs two INFO samples. Also resets when Redis restarts. This is not zero.";
  const base = `${formatCores(cores)} — used_cpu_sys + used_cpu_user per second, as a share of one core.`;
  if (cores > 1)
    return `${base} Above 100%: Redis is using more than one core, which its background threads (persistence, lazy free) can legitimately do — the command loop itself is still single threaded.`;
  return `${base} Redis runs its command loop on a single thread, so 100% is the practical ceiling.`;
}
