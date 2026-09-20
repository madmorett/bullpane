import { useMemo, useState } from "react";
import { Activity, BarChart3, Gauge, Info, Timer } from "lucide-react";
import type { JobState, QueueSummary } from "@bullpane/shared";
import { JOB_STATES } from "@bullpane/shared";
import { cn } from "@/lib/cn";
import { formatCompact, formatDuration, formatNumber, formatPercent } from "@/lib/format";
import { STATE_COLORS } from "@/lib/stateColors";
import {
  METRIC_RANGES,
  RANGE_LABEL,
  hasMetrics,
  latencySample,
  sliceMetrics,
  successSeries,
  throughput,
  type DurationStats,
  type MetricRange,
} from "@/lib/queueMetrics";
import { useJobs } from "@/api/hooks";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { CodeBlock } from "@/components/ui/CodeBlock";
import { Tooltip } from "@/components/ui/Tooltip";
import { ChartLegend, TimeSeriesChart, type Series } from "@/components/charts/TimeSeriesChart";
import { SuccessBar } from "@/components/queues/QueueCard";
import { rateSourceHint } from "@/components/queues/RateSource";

/** one page of completed jobs is enough for a latency sample without hammering Redis */
const LATENCY_SAMPLE_SIZE = 50;

export function QueueMetricsPanel({
  connectionId,
  queue,
  summary,
  onOpenState,
}: {
  connectionId: string;
  queue: string;
  summary: QueueSummary | undefined;
  onOpenState: (state: JobState) => void;
}) {
  const [range, setRange] = useState<MetricRange>(60);
  const metrics = summary?.metrics;
  const collecting = hasMetrics(metrics);

  const slice = useMemo(() => sliceMetrics(metrics, range), [metrics, range]);
  const tp = useMemo(() => throughput(slice), [slice]);
  const success = useMemo(() => successSeries(slice), [slice]);

  return (
    <div className="space-y-3">
      <StatTiles counts={summary?.counts} onOpenState={onOpenState} />

      {collecting ? (
        <>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-xs font-semibold tracking-wider text-fg-subtle uppercase">Throughput &amp; history</h2>
            <RangeSelector value={range} onChange={setRange} available={slice.available} />
          </div>

          {slice.truncated && (
            <p className="text-[11px] text-fg-subtle" role="status">
              This queue only stores {formatNumber(slice.available)} minute{slice.available === 1 ? "" : "s"} of metrics — showing everything it has.
              BullMQ keeps one point per minute up to the worker&apos;s <code className="font-mono text-fg-muted">maxDataPoints</code>.
            </p>
          )}

          <ThroughputRow rates={summary?.rates} tp={tp} minutes={slice.minutes} />

          <div className="grid gap-3 xl:grid-cols-2">
            <ChartCard
              icon={<BarChart3 />}
              title="Processed"
              hint={`Completed and failed per minute over the last ${formatNumber(slice.minutes)} min, straight from BullMQ's own metrics collection.`}
              legend={PROCESSED_LEGEND}
            >
              <TimeSeriesChart
                height={190}
                ariaLabel="Completed and failed jobs per minute"
                series={[
                  { key: "completed", label: "Completed", color: STATE_COLORS.completed.fg, values: slice.completed, area: true },
                  { key: "failed", label: "Failed", color: STATE_COLORS.failed.fg, values: slice.failed, area: true },
                ]}
                formatValue={(v) => formatCompact(Math.round(v))}
              />
            </ChartCard>

            <ChartCard
              icon={<Activity />}
              title="Success rate"
              hint="completed / (completed + failed) per minute. A minute where nothing finished is a gap, not 0 %."
            >
              <TimeSeriesChart
                height={190}
                maxY={100}
                ariaLabel="Success rate per minute"
                series={[{ key: "success", label: "Success", color: STATE_COLORS.completed.fg, values: success, area: true }]}
                formatValue={(v) => `${Math.round(v)}%`}
              />
            </ChartCard>
          </div>
        </>
      ) : (
        <NoMetricsState />
      )}

      <LatencySection connectionId={connectionId} queue={queue} completedCount={summary?.counts.completed ?? 0} />
    </div>
  );
}

const PROCESSED_LEGEND: Pick<Series, "key" | "label" | "color">[] = [
  { key: "completed", label: "Completed", color: STATE_COLORS.completed.fg },
  { key: "failed", label: "Failed", color: STATE_COLORS.failed.fg },
];

// ---------------------------------------------------------------------------
// Stat tiles
// ---------------------------------------------------------------------------

function StatTiles({ counts, onOpenState }: { counts: QueueSummary["counts"] | undefined; onOpenState: (s: JobState) => void }) {
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 xl:grid-cols-8">
      {JOB_STATES.map((s) => {
        const c = STATE_COLORS[s];
        const v = counts?.[s];
        return (
          <button
            key={s}
            type="button"
            onClick={() => onOpenState(s)}
            className="card group flex flex-col items-start gap-0.5 px-3 py-2.5 text-left transition-colors hover:border-border-strong hover:bg-surface-2"
            title={`Show ${c.label} jobs`}
          >
            <span className="flex items-center gap-1.5 text-[10px] font-medium tracking-wider text-fg-subtle uppercase">
              <span className={cn("status-dot size-1.5", c.dotClass)} aria-hidden />
              {c.label}
            </span>
            <span className={cn("num text-2xl leading-tight font-semibold", v == null ? "text-fg-subtle" : v > 0 ? c.textClass : "text-fg-muted")}>
              {v == null ? "—" : formatCompact(v)}
            </span>
          </button>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Range selector
// ---------------------------------------------------------------------------

function RangeSelector({ value, onChange, available }: { value: MetricRange; onChange: (r: MetricRange) => void; available: number }) {
  return (
    <div className="flex items-center gap-0.5 rounded-md bg-surface-2 p-0.5" role="group" aria-label="Metrics range">
      {METRIC_RANGES.map((r) => {
        const beyond = r !== 0 && r > available;
        return (
          <button
            key={r}
            type="button"
            aria-pressed={value === r}
            onClick={() => onChange(r)}
            title={beyond ? `Only ${formatNumber(available)} min of data available` : undefined}
            className={cn(
              "h-6 rounded px-2 text-[11px] font-medium transition-colors",
              value === r ? "bg-surface text-fg shadow-sm" : "text-fg-muted hover:text-fg",
              beyond && value !== r && "opacity-50",
            )}
          >
            {RANGE_LABEL[r]}
          </button>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Throughput
// ---------------------------------------------------------------------------

function ThroughputRow({
  rates,
  tp,
  minutes,
}: {
  rates: QueueSummary["rates"] | undefined;
  tp: ReturnType<typeof throughput>;
  minutes: number;
}) {
  return (
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
      <Metric
        icon={<Gauge />}
        label="Throughput"
        value={tp.perHour == null ? "—" : `${formatCompact(Math.round(tp.perHour))}`}
        unit="jobs / hour"
        hint={`Mean over the last ${formatNumber(minutes)} min, projected to an hour. Not a count of the past hour.`}
      />
      <Metric
        icon={<Gauge />}
        label="Rate"
        value={tp.perMinute == null ? "—" : tp.perMinute.toFixed(tp.perMinute < 10 ? 1 : 0)}
        unit="jobs / min"
        hint={`Mean completed per minute over the last ${formatNumber(minutes)} min.`}
      />
      <div className="card px-3 py-2.5">
        <div className="mb-1.5 text-[10px] font-medium tracking-wider text-fg-subtle uppercase">Finished · window</div>
        <div className="num flex items-baseline gap-3 text-sm">
          <span style={{ color: STATE_COLORS.completed.fg }}>{formatCompact(tp.completed)} ok</span>
          <span style={{ color: STATE_COLORS.failed.fg }}>{formatCompact(tp.failed)} failed</span>
          <span className="ml-auto text-fg-muted">{tp.successPct == null ? "—" : formatPercent(tp.successPct)}</span>
        </div>
      </div>
      <div className="card px-3 py-2.5">
        <div className="mb-1.5 flex items-center gap-1 text-[10px] font-medium tracking-wider text-fg-subtle uppercase">
          Success · trailing window
          {/* Says outright whether this comes from BullMQ metrics or from the zsets;
              SuccessBar itself dims the value and flags it when retention skews it. */}
          <Tooltip content={rateSourceHint(rates)} className="ml-auto normal-case">
            <span className="text-[10px] text-fg-subtle">{rates?.source === "metrics" ? "metrics" : "zsets"}</span>
          </Tooltip>
        </div>
        <SuccessBar rates={rates} />
      </div>
    </div>
  );
}

function Metric({ icon, label, value, unit, hint }: { icon: React.ReactNode; label: string; value: string; unit: string; hint: string }) {
  return (
    <div className="card px-3 py-2.5">
      <div className="mb-0.5 flex items-center gap-1.5 text-[10px] font-medium tracking-wider text-fg-subtle uppercase">
        <span className="[&_svg]:size-3" aria-hidden>
          {icon}
        </span>
        {label}
        <Tooltip content={hint} className="ml-auto">
          <Info className="size-3 text-fg-subtle" aria-label={hint} />
        </Tooltip>
      </div>
      <div className="flex items-baseline gap-1.5">
        <span className="num text-2xl leading-tight font-semibold text-fg">{value}</span>
        <span className="text-[11px] text-fg-subtle">{unit}</span>
      </div>
    </div>
  );
}

function ChartCard({
  icon,
  title,
  hint,
  legend,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  hint: string;
  legend?: Pick<Series, "key" | "label" | "color">[];
  children: React.ReactNode;
}) {
  return (
    <section className="card p-3">
      <header className="mb-2 flex flex-wrap items-center gap-2">
        <h3 className="flex items-center gap-1.5 text-xs font-semibold text-fg [&_svg]:size-3.5 [&_svg]:text-fg-subtle">
          {icon}
          {title}
        </h3>
        {legend && <ChartLegend series={legend} className="ml-auto" />}
      </header>
      {children}
      <p className="mt-1.5 text-[11px] leading-relaxed text-fg-subtle">{hint}</p>
    </section>
  );
}

// ---------------------------------------------------------------------------
// No metrics
// ---------------------------------------------------------------------------

function NoMetricsState() {
  return (
    <div className="card">
      <EmptyState
        icon={<BarChart3 />}
        title="This queue is not collecting metrics"
        description={
          <>
            BullMQ only records per-minute completed/failed counts when the <strong className="text-fg">Worker</strong> is created with the{" "}
            <code className="font-mono text-fg">metrics</code> option. Nothing in Redis can be back-filled, so there is no history to show — turn it on and
            points start accumulating one per minute.
          </>
        }
      />
      <div className="px-6 pb-6">
        <CodeBlock
          className="mx-auto max-w-2xl"
          language="ts"
          code={`new Worker(name, fn, { metrics: { maxDataPoints: MetricsTime.ONE_WEEK } })`}
        />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Response / process time
// ---------------------------------------------------------------------------

function LatencySection({ connectionId, queue, completedCount }: { connectionId: string; queue: string; completedCount: number }) {
  const jobs = useJobs(
    connectionId,
    queue,
    { state: "completed", page: 1, pageSize: LATENCY_SAMPLE_SIZE, order: "desc" },
    { enabled: completedCount > 0 },
  );
  const sample = useMemo(() => latencySample(jobs.data?.jobs), [jobs.data?.jobs]);
  const n = sample.sampled;
  const note = `Measured from the ${formatNumber(n)} most recent completed job${n === 1 ? "" : "s"} on this queue. A sample, not a server-wide statistic — BullMQ stores no aggregate timings in Redis.`;

  return (
    <section className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="flex items-center gap-1.5 text-xs font-semibold tracking-wider text-fg-subtle uppercase">
          <Timer className="size-3.5" aria-hidden />
          Timings
        </h2>
        <Tooltip content={note}>
          <span className="inline-flex items-center gap-1 rounded border border-border bg-surface-2 px-1.5 py-0.5 text-[10px] text-fg-muted">
            <Info className="size-3" aria-hidden />
            sample of {formatNumber(n)}
          </span>
        </Tooltip>
      </div>

      {completedCount === 0 ? (
        <div className="card">
          <EmptyState compact title="No completed jobs yet" description="Wait times and process times are derived from finished jobs." />
        </div>
      ) : (
        <div className="grid gap-3 lg:grid-cols-2">
          <DurationCard
            title="Response time"
            subtitle="time in queue · processedOn − timestamp"
            stats={sample.wait}
            loading={jobs.isLoading}
            color={STATE_COLORS.waiting.fg}
            note={note}
          />
          <DurationCard
            title="Process time"
            subtitle="time in workers · finishedOn − processedOn"
            stats={sample.process}
            loading={jobs.isLoading}
            color={STATE_COLORS.active.fg}
            note={note}
          />
        </div>
      )}
    </section>
  );
}

function DurationCard({
  title,
  subtitle,
  stats,
  loading,
  color,
  note,
}: {
  title: string;
  subtitle: string;
  stats: DurationStats | null;
  loading: boolean;
  color: string;
  note: string;
}) {
  const cells: { label: string; value: number | null }[] = [
    { label: "min", value: stats?.min ?? null },
    { label: "median", value: stats?.median ?? null },
    { label: "p95", value: stats?.p95 ?? null },
    { label: "max", value: stats?.max ?? null },
  ];
  return (
    <div className="card p-3" title={note}>
      <header className="mb-2 flex items-baseline gap-2">
        <h3 className="flex items-center gap-1.5 text-xs font-semibold text-fg">
          <span className="size-2 rounded-full" style={{ background: color }} aria-hidden />
          {title}
        </h3>
        <span className="truncate font-mono text-[10px] text-fg-subtle">{subtitle}</span>
      </header>
      <div className="grid grid-cols-4 gap-px overflow-hidden rounded-md bg-border">
        {cells.map((c) => (
          <div key={c.label} className="bg-surface px-2 py-2">
            <div className="text-[10px] tracking-wide text-fg-subtle uppercase">{c.label}</div>
            <div className="num truncate text-[15px] font-semibold text-fg">
              {loading ? <span className="skeleton inline-block h-3.5 w-12" /> : c.value == null ? "—" : formatDuration(c.value)}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
