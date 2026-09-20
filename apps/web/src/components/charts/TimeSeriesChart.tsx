import { useCallback, useEffect, useId, useMemo, useRef, useState, type PointerEvent } from "react";
import { cn } from "@/lib/cn";
import { formatCompact, formatNumber } from "@/lib/format";

/**
 * Hand-rolled SVG chart. The project ships no charting library and the bundle
 * is already ~500 KB, so anything that draws a line here draws it itself.
 *
 * The X axis is "minutes ago": index 0 is the OLDEST point, the last index is
 * the most recent minute, matching how BullMQ stores its metrics arrays.
 */
export interface Series {
  key: string;
  label: string;
  /** CSS colour — pass a var(--state-*) so the chart follows the theme */
  color: string;
  /** oldest first. `null` is a hole, not a zero. */
  values: (number | null)[];
  /** draw the area under the line */
  area?: boolean;
  dashed?: boolean;
}

export interface TimeSeriesChartProps {
  series: Series[];
  height?: number;
  className?: string;
  /** formats a value for the tooltip + Y axis. Defaults to compact numbers. */
  formatValue?: (v: number) => string;
  /** label for a point at index i, e.g. "12 min ago". */
  formatX?: (index: number, total: number) => string;
  /** pin the Y axis top (percentages want 100) */
  maxY?: number;
  /** accessible description */
  ariaLabel?: string;
  /** render nothing but a baseline when every series is empty */
  emptyText?: string;
}

const PAD = { top: 10, right: 8, bottom: 20, left: 40 };
const GRID_LINES = 4;

export function TimeSeriesChart({
  series,
  height = 180,
  className,
  formatValue = formatCompact,
  formatX = defaultFormatX,
  maxY,
  ariaLabel,
  emptyText = "No data",
}: TimeSeriesChartProps) {
  const id = useId();
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [hover, setHover] = useState<number | null>(null);
  // Fixed viewBox width; the SVG scales to the container with preserveAspectRatio="none"
  // on the X axis only, which keeps text crisp because we never scale the text.
  const [width, setWidth] = useState(720);

  const points = Math.max(...series.map((s) => s.values.length), 0);

  const { max, plotW, plotH, scaleX, scaleY } = useMemo(() => {
    const all = series.flatMap((s) => s.values.filter((v): v is number => v != null && Number.isFinite(v)));
    const rawMax = all.length ? Math.max(...all) : 0;
    const m = maxY ?? niceMax(rawMax);
    const pw = Math.max(1, width - PAD.left - PAD.right);
    const ph = Math.max(1, height - PAD.top - PAD.bottom);
    const sx = (i: number) => PAD.left + (points > 1 ? (i / (points - 1)) * pw : pw / 2);
    const sy = (v: number) => PAD.top + ph - (m > 0 ? (v / m) * ph : 0);
    return { max: m, plotW: pw, plotH: ph, scaleX: sx, scaleY: sy };
  }, [series, width, height, maxY, points]);

  const hasData = points > 0 && series.some((s) => s.values.some((v) => v != null));

  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const box = wrapRef.current?.getBoundingClientRect();
    if (!box || points === 0) return;
    // map client X -> viewBox X -> index
    const vbX = ((e.clientX - box.left) / box.width) * width;
    const rel = (vbX - PAD.left) / plotW;
    const i = Math.round(rel * (points - 1));
    setHover(i >= 0 && i < points ? i : null);
  };

  // Track the real rendered width so the X scale matches what the user points at.
  const [node, setNode] = useState<HTMLDivElement | null>(null);
  const measure = useCallback((el: HTMLDivElement | null) => {
    wrapRef.current = el;
    setNode(el);
  }, []);

  useEffect(() => {
    if (!node || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(([entry]) => {
      const w = Math.round(entry.contentRect.width);
      if (w > 0) setWidth(w);
    });
    ro.observe(node);
    return () => ro.disconnect();
  }, [node]);

  const gridValues = Array.from({ length: GRID_LINES + 1 }, (_, i) => (max / GRID_LINES) * i);

  return (
    <div
      ref={measure}
      className={cn("relative w-full select-none", className)}
      onPointerMove={onPointerMove}
      onPointerLeave={() => setHover(null)}
    >
      <svg
        width="100%"
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={ariaLabel ?? series.map((s) => s.label).join(" and ")}
        className="overflow-visible"
      >
        <defs>
          {series.map((s) => (
            <linearGradient key={s.key} id={`area-${id}-${s.key}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={s.color} stopOpacity={0.28} />
              <stop offset="100%" stopColor={s.color} stopOpacity={0.02} />
            </linearGradient>
          ))}
        </defs>

        {/* gridlines + Y labels */}
        {gridValues.map((v, i) => {
          const y = scaleY(v);
          return (
            <g key={i}>
              <line x1={PAD.left} x2={width - PAD.right} y1={y} y2={y} stroke="var(--border)" strokeWidth={1} shapeRendering="crispEdges" />
              <text x={PAD.left - 6} y={y + 3} textAnchor="end" className="fill-[var(--fg-subtle)] text-[9px]" style={{ fontVariantNumeric: "tabular-nums" }}>
                {formatValue(v)}
              </text>
            </g>
          );
        })}

        {!hasData ? (
          <text x={width / 2} y={height / 2} textAnchor="middle" className="fill-[var(--fg-subtle)] text-[11px]">
            {emptyText}
          </text>
        ) : (
          <>
            {series.map((s) => (
              <SeriesPath key={s.key} series={s} gradientId={`area-${id}-${s.key}`} scaleX={scaleX} scaleY={scaleY} baseline={PAD.top + plotH} />
            ))}

            {/* hover crosshair + dots */}
            {hover != null && (
              <g pointerEvents="none">
                <line x1={scaleX(hover)} x2={scaleX(hover)} y1={PAD.top} y2={PAD.top + plotH} stroke="var(--fg-subtle)" strokeWidth={1} strokeDasharray="3 3" />
                {series.map((s) => {
                  const v = s.values[hover];
                  if (v == null || !Number.isFinite(v)) return null;
                  return <circle key={s.key} cx={scaleX(hover)} cy={scaleY(v)} r={3} fill={s.color} stroke="var(--surface)" strokeWidth={1.5} />;
                })}
              </g>
            )}
          </>
        )}

        {/* X axis ticks: oldest, middle, newest */}
        {hasData && points > 1 && (
          <g>
            {[0, Math.floor((points - 1) / 2), points - 1].map((i, n) => (
              <text
                key={i}
                x={scaleX(i)}
                y={height - 6}
                textAnchor={n === 0 ? "start" : n === 2 ? "end" : "middle"}
                className="fill-[var(--fg-subtle)] text-[9px]"
              >
                {formatX(i, points)}
              </text>
            ))}
          </g>
        )}
      </svg>

      {hover != null && hasData && (
        <ChartTooltip
          xPct={(scaleX(hover) / width) * 100}
          title={formatX(hover, points)}
          rows={series
            .map((s) => ({ label: s.label, color: s.color, value: s.values[hover] }))
            .filter((r): r is { label: string; color: string; value: number } => r.value != null && Number.isFinite(r.value))}
          formatValue={formatValue}
        />
      )}
    </div>
  );
}

function SeriesPath({
  series,
  gradientId,
  scaleX,
  scaleY,
  baseline,
}: {
  series: Series;
  gradientId: string;
  scaleX: (i: number) => number;
  scaleY: (v: number) => number;
  baseline: number;
}) {
  // split on nulls so holes stay holes instead of becoming a fake zero
  const segments: [number, number][][] = [];
  let cur: [number, number][] | null = null;
  series.values.forEach((v, i) => {
    if (v == null || !Number.isFinite(v)) {
      cur = null;
      return;
    }
    const pt: [number, number] = [scaleX(i), scaleY(v)];
    if (!cur) {
      cur = [pt];
      segments.push(cur);
    } else cur.push(pt);
  });

  return (
    <g>
      {segments.map((pts, i) => {
        const d = pts.map(([x, y], j) => `${j === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
        return (
          <g key={i}>
            {series.area && pts.length > 1 && (
              <path d={`${d} L${pts[pts.length - 1][0].toFixed(1)},${baseline} L${pts[0][0].toFixed(1)},${baseline} Z`} fill={`url(#${gradientId})`} />
            )}
            {pts.length > 1 ? (
              <path d={d} fill="none" stroke={series.color} strokeWidth={1.6} strokeLinejoin="round" strokeLinecap="round" strokeDasharray={series.dashed ? "4 3" : undefined} vectorEffect="non-scaling-stroke" />
            ) : (
              <circle cx={pts[0][0]} cy={pts[0][1]} r={1.8} fill={series.color} />
            )}
          </g>
        );
      })}
    </g>
  );
}

function ChartTooltip({
  xPct,
  title,
  rows,
  formatValue,
}: {
  xPct: number;
  title: string;
  rows: { label: string; color: string; value: number }[];
  formatValue: (v: number) => string;
}) {
  if (rows.length === 0) return null;
  // flip the card to the left half once the cursor passes the middle
  const flip = xPct > 55;
  return (
    <div
      className="pointer-events-none absolute top-1 z-10 min-w-32 rounded-md border border-border bg-surface px-2 py-1.5 text-[11px] shadow-[var(--shadow)]"
      style={{ left: `${xPct}%`, transform: flip ? "translateX(calc(-100% - 8px))" : "translateX(8px)" }}
      role="status"
    >
      <div className="mb-1 text-fg-subtle">{title}</div>
      {rows.map((r) => (
        <div key={r.label} className="flex items-center gap-1.5 whitespace-nowrap">
          <span className="size-2 shrink-0 rounded-full" style={{ background: r.color }} aria-hidden />
          <span className="text-fg-muted">{r.label}</span>
          <span className="num ml-auto font-medium text-fg">{formatValue(r.value)}</span>
        </div>
      ))}
    </div>
  );
}

/** legend row shared by the metric cards */
export function ChartLegend({ series, className }: { series: Pick<Series, "key" | "label" | "color">[]; className?: string }) {
  return (
    <div className={cn("flex flex-wrap items-center gap-3 text-[11px] text-fg-muted", className)}>
      {series.map((s) => (
        <span key={s.key} className="flex items-center gap-1.5">
          <span className="h-0.5 w-3 rounded-full" style={{ background: s.color }} aria-hidden />
          {s.label}
        </span>
      ))}
    </div>
  );
}

function defaultFormatX(index: number, total: number): string {
  const ago = total - 1 - index;
  if (ago === 0) return "now";
  return `${formatNumber(ago)} min ago`;
}

/** round a max up to something that divides cleanly by 4 for the gridlines */
function niceMax(v: number): number {
  if (!Number.isFinite(v) || v <= 0) return 4;
  const mag = 10 ** Math.floor(Math.log10(v));
  for (const step of [1, 2, 2.5, 5, 10]) {
    const candidate = step * mag;
    if (candidate >= v) return candidate;
  }
  return 10 * mag;
}
