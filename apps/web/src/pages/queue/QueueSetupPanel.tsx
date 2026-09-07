import { useState, type ReactNode } from "react";
import { Activity, Boxes, Braces, ChevronDown, ChevronRight, Gauge, History, Hourglass, Layers, Package, Timer, Users } from "lucide-react";
import type { QueueSetup } from "@bullpane/shared";
import { cn } from "@/lib/cn";
import { formatNumber } from "@/lib/format";
import { readStorage, writeStorage } from "@/lib/storage";
import { useNow } from "@/lib/useNow";
import { useQueueSetup } from "@/api/hooks";
import { errorMessage, isApiError } from "@/api/client";
import { Badge } from "@/components/ui/Badge";
import { Tooltip } from "@/components/ui/Tooltip";
import { Skeleton } from "@/components/ui/Spinner";

const STORAGE_KEY = "queueSetup.open";

/**
 * What Redis knows about how the queue is configured. Anything that lives only
 * in worker options (batch, worker concurrency) is labelled as not observable
 * instead of being guessed.
 */
export function QueueSetupPanel({ connectionId, queue, className }: { connectionId: string; queue: string; className?: string }) {
  const [open, setOpen] = useState<boolean>(() => readStorage<boolean>(STORAGE_KEY, true));
  const setup = useQueueSetup(connectionId, queue);
  const data = setup.data;

  const toggle = () => {
    setOpen((o) => {
      writeStorage(STORAGE_KEY, !o);
      return !o;
    });
  };

  return (
    <section className={cn("card overflow-hidden", className)} aria-label="Queue setup">
      <button type="button" onClick={toggle} aria-expanded={open} className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-surface-2/60">
        {open ? <ChevronDown className="size-3.5 text-fg-subtle" aria-hidden /> : <ChevronRight className="size-3.5 text-fg-subtle" aria-hidden />}
        <span className="text-xs font-semibold tracking-wider text-fg-subtle uppercase">Setup</span>
        {!open && data && <Summary data={data} />}
        {data?.rateLimitedNow && <ThrottledPill ttlMs={data.rateLimitedNow.ttlMs} since={setup.dataUpdatedAt} />}
        <span className="ml-auto text-[11px] text-fg-subtle">from Redis · refreshes every 10 s</span>
      </button>

      {open && (
        <div className="border-t border-border px-3 py-2.5">
          {setup.isLoading && !data && (
            <div className="grid gap-x-6 gap-y-2 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
              {Array.from({ length: 10 }, (_, i) => (
                <div key={i} className="flex flex-col gap-1">
                  <Skeleton className="h-2.5 w-20" />
                  <Skeleton className="h-3 w-28" />
                </div>
              ))}
            </div>
          )}
          {setup.isError && !data && (
            <p className="text-xs text-fg-muted">
              {isApiError(setup.error) && setup.error.status === 404 ? "Setup details are not available on this server version." : `Setup unavailable: ${errorMessage(setup.error)}`}
            </p>
          )}
          {data && <SetupGrid data={data} since={setup.dataUpdatedAt} />}
        </div>
      )}
    </section>
  );
}

function Summary({ data }: { data: QueueSetup }) {
  const lib = parseLibrary(data.library);
  return (
    <span className="flex min-w-0 items-center gap-2 truncate text-xs text-fg-muted">
      <span className="font-mono">{lib ? `${lib.name} ${lib.version}` : "library unknown"}</span>
      <span className="text-fg-subtle">·</span>
      <span>{data.workers ? `${formatNumber(data.workers.count)} ${data.workers.count === 1 ? "worker" : "workers"}` : "workers unknown"}</span>
      <span className="text-fg-subtle">·</span>
      <span>concurrency {data.globalConcurrency ?? "not set"}</span>
    </span>
  );
}

function SetupGrid({ data, since }: { data: QueueSetup; since: number }) {
  const lib = parseLibrary(data.library);
  const g = data.groups;
  return (
    <>
      <dl className="grid gap-x-6 gap-y-2.5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
        <Item icon={<Package />} label="Library">
          {lib ? (
            <span className="flex items-center gap-1.5">
              <span className="font-mono">
                {lib.name} {lib.version}
              </span>
              {data.isPro && (
                <Badge variant="pro" size="xs" className="tracking-wider">
                  PRO
                </Badge>
              )}
            </span>
          ) : (
            <Unknown>unknown</Unknown>
          )}
        </Item>

        <Item icon={<Users />} label="Workers connected">
          {data.workers ? (
            <Tooltip content={data.workers.names.length ? namesTooltip(data.workers.names) : "no worker names reported"} side="bottom">
              <span className="num cursor-help underline decoration-dotted underline-offset-2">{formatNumber(data.workers.count)}</span>
            </Tooltip>
          ) : (
            <Unknown title="CLIENT LIST is unavailable on this Redis (ACL or managed service)">unknown</Unknown>
          )}
        </Item>

        <Item icon={<Gauge />} label="Global concurrency">{data.globalConcurrency != null ? <span className="num">{formatNumber(data.globalConcurrency)}</span> : <Unknown>not set</Unknown>}</Item>

        <Item icon={<Timer />} label="Global rate limit">
          {data.globalRateLimit ? (
            <span className="num">
              {formatNumber(data.globalRateLimit.max)} / {compactDuration(data.globalRateLimit.durationMs)}
            </span>
          ) : (
            <Unknown>not set</Unknown>
          )}
        </Item>

        <Item icon={<Hourglass />} label="Rate limited now">{data.rateLimitedNow ? <ThrottledPill ttlMs={data.rateLimitedNow.ttlMs} since={since} /> : <span className="text-fg-muted">no</span>}</Item>

        <Item icon={<Layers />} label="Groups" className="xl:col-span-2">
          {g ? (
            <span className="flex flex-wrap items-center gap-x-3 gap-y-0.5">
              <span className="num">
                {formatNumber(g.count)} {g.count === 1 ? "group" : "groups"}
              </span>
              <span className="text-fg-muted">
                per-group concurrency limits: <YesNo v={g.concurrencyLimited} />
              </span>
              <span className="text-fg-muted">
                per-group rate limits: <YesNo v={g.rateLimited} />
              </span>
              <span className="num text-fg-muted">
                {formatNumber(g.activeGroups)} active · {formatNumber(g.pausedGroups)} paused
              </span>
            </span>
          ) : (
            <Unknown title="No BullMQ Pro group keys found for this queue">none observed</Unknown>
          )}
        </Item>

        <Item icon={<Boxes />} label="Batch">
          <Tooltip content="Batching is a Worker option (worker.opts.batch); BullMQ does not persist it in Redis, so it cannot be read from here." side="bottom">
            <Unknown className="cursor-help underline decoration-dotted underline-offset-2">not observable from Redis</Unknown>
          </Tooltip>
        </Item>

        <Item icon={<Activity />} label="Metrics">{data.metricsEnabled ? <span className="text-state-completed">enabled</span> : <Unknown>disabled</Unknown>}</Item>

        <Item icon={<History />} label="Max events">{data.maxLenEvents != null ? <span className="num">{formatNumber(data.maxLenEvents)}</span> : <Unknown>not set</Unknown>}</Item>
      </dl>

      <details className="mt-2.5 border-t border-border pt-2 text-xs">
        <summary className="inline-flex cursor-pointer items-center gap-1.5 text-fg-muted select-none hover:text-fg">
          <Braces className="size-3.5" aria-hidden /> Raw meta
          <span className="num text-fg-subtle">({Object.keys(data.rawMeta ?? {}).length} fields)</span>
        </summary>
        {Object.keys(data.rawMeta ?? {}).length === 0 ? (
          <p className="mt-1.5 text-fg-subtle">The meta hash has no extra fields.</p>
        ) : (
          <table className="mt-1.5 w-auto text-[11px]">
            <tbody>
              {Object.entries(data.rawMeta)
                .sort(([a], [b]) => a.localeCompare(b))
                .map(([k, v]) => (
                  <tr key={k} className="border-t border-border/60">
                    <th scope="row" className="py-0.5 pr-4 text-left font-mono font-normal text-fg-muted">
                      {k}
                    </th>
                    <td className="py-0.5 font-mono break-all text-fg">{v === "" ? <span className="text-fg-subtle">(empty)</span> : v}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        )}
      </details>
    </>
  );
}

function Item({ icon, label, children, className }: { icon: ReactNode; label: string; children: ReactNode; className?: string }) {
  return (
    <div className={cn("flex min-w-0 items-start gap-2", className)}>
      <span className="mt-0.5 shrink-0 text-fg-subtle [&_svg]:size-3.5" aria-hidden>
        {icon}
      </span>
      <div className="min-w-0">
        <dt className="text-[10px] tracking-wide text-fg-subtle uppercase">{label}</dt>
        <dd className="text-[13px] text-fg">{children}</dd>
      </div>
    </div>
  );
}

function Unknown({ children, title, className }: { children: ReactNode; title?: string; className?: string }) {
  return (
    <span className={cn("text-fg-subtle", className)} title={title}>
      {children}
    </span>
  );
}

function YesNo({ v }: { v: boolean }) {
  return <span className={v ? "text-fg" : "text-fg-subtle"}>{v ? "yes" : "no"}</span>;
}

/** Live "throttled · lifts in Xs" pill; counts down from the TTL observed at fetch time. */
function ThrottledPill({ ttlMs, since }: { ttlMs: number; since: number }) {
  const now = useNow(1000);
  const remaining = Math.max(0, ttlMs - Math.max(0, now - since));
  return (
    <Badge variant="custom" size="xs" dot className="border tracking-wide" style={{ color: "var(--state-waiting)", background: "color-mix(in srgb, var(--state-waiting) 14%, transparent)", borderColor: "color-mix(in srgb, var(--state-waiting) 38%, transparent)" }}>
      throttled · lifts in {compactDuration(remaining)}
    </Badge>
  );
}

function parseLibrary(v: string | null): { name: string; version: string } | null {
  if (!v) return null;
  const idx = v.indexOf(":");
  if (idx < 0) return { name: v, version: "" };
  return { name: v.slice(0, idx), version: v.slice(idx + 1) };
}

function compactDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "–";
  if (ms >= 3_600_000 && ms % 3_600_000 === 0) return `${ms / 3_600_000}h`;
  if (ms >= 60_000 && ms % 60_000 === 0) return `${ms / 60_000}m`;
  if (ms >= 1000) return `${Math.round(ms / 100) / 10}s`.replace(/\.0s$/, "s");
  return `${Math.round(ms)}ms`;
}

function namesTooltip(names: string[]): string {
  const shown = names.slice(0, 12);
  return shown.join(", ") + (names.length > shown.length ? ` +${names.length - shown.length} more` : "");
}
