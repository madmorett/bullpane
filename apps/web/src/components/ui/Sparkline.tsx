import { useId } from "react";
import { cn } from "@/lib/cn";

export interface SparklineProps {
  /**
   * The series, oldest first. `null` entries are HOLES, not zeros: the line
   * breaks across them. Health rates are null on the first sample and after a
   * Redis restart, and drawing those as 0 would invent a dip that never happened.
   */
  values: (number | null | undefined)[] | undefined | null;
  width?: number;
  height?: number;
  className?: string;
  /** CSS colour; defaults to currentColor */
  stroke?: string;
  fill?: boolean;
  title?: string;
  /**
   * Scale the Y axis from the series minimum instead of from 0. Useful for
   * memory, which never starts at zero and would otherwise look flat.
   */
  zeroBased?: boolean;
  /** dim the whole chart — used when the sample is stale (connection down) */
  dimmed?: boolean;
}

interface Seg {
  pts: [number, number][];
}

export function Sparkline({
  values,
  width = 96,
  height = 22,
  className,
  stroke = "currentColor",
  fill = true,
  title,
  zeroBased = true,
  dimmed,
}: SparklineProps) {
  const id = useId();
  const raw = (values ?? []).map((v) => (typeof v === "number" && Number.isFinite(v) ? v : null));
  const present = raw.filter((v): v is number => v !== null);

  if (present.length < 2) {
    return (
      <span
        className={cn("inline-block text-fg-subtle/40", className)}
        style={{ width, height }}
        aria-hidden
      >
        <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`}>
          <line x1={0} y1={height - 1} x2={width} y2={height - 1} stroke="currentColor" strokeDasharray="2 3" />
        </svg>
      </span>
    );
  }

  const hi = Math.max(...present);
  const lo = zeroBased ? Math.min(0, ...present) : Math.min(...present);
  const max = hi === lo ? hi + 1 : hi;
  const min = hi === lo ? lo - (zeroBased ? 0 : 1) : lo;
  const pad = 1.5;
  const stepX = raw.length > 1 ? (width - pad * 2) / (raw.length - 1) : 0;
  const scaleY = (v: number) => height - pad - ((v - min) / (max - min || 1)) * (height - pad * 2);

  // Split into contiguous runs so nulls become visible gaps.
  const segs: Seg[] = [];
  let cur: Seg | null = null;
  raw.forEach((v, i) => {
    if (v === null) {
      cur = null;
      return;
    }
    const pt: [number, number] = [pad + i * stepX, scaleY(v)];
    if (!cur) {
      cur = { pts: [pt] };
      segs.push(cur);
    } else {
      cur.pts.push(pt);
    }
  });

  const toPath = (pts: [number, number][]) =>
    pts.map(([x, y], i) => `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`).join(" ");

  const lastSeg = segs[segs.length - 1];
  const lastPt = lastSeg?.pts[lastSeg.pts.length - 1];

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className={cn("inline-block overflow-visible align-middle", dimmed && "opacity-40", className)}
      role="img"
      aria-label={title ?? `Sparkline, ${present.length} points`}
    >
      {title && <title>{title}</title>}
      {fill && (
        <defs>
          <linearGradient id={`g-${id}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={stroke} stopOpacity={0.35} />
            <stop offset="100%" stopColor={stroke} stopOpacity={0} />
          </linearGradient>
        </defs>
      )}
      {segs.map((seg, i) => {
        if (seg.pts.length < 2) {
          const [x, y] = seg.pts[0];
          return <circle key={i} cx={x} cy={y} r={1.4} fill={stroke} />;
        }
        const path = toPath(seg.pts);
        const x0 = seg.pts[0][0];
        const x1 = seg.pts[seg.pts.length - 1][0];
        return (
          <g key={i}>
            {fill && <path d={`${path} L${x1.toFixed(1)},${height} L${x0.toFixed(1)},${height} Z`} fill={`url(#g-${id})`} />}
            <path d={path} fill="none" stroke={stroke} strokeWidth={1.4} strokeLinejoin="round" strokeLinecap="round" />
          </g>
        );
      })}
      {lastPt && <circle cx={lastPt[0]} cy={lastPt[1]} r={1.8} fill={stroke} />}
    </svg>
  );
}
