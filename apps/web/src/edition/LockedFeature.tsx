import { Link } from "react-router-dom";
import { Check, ExternalLink, KeyRound, Lock } from "lucide-react";
import type { ProFeature } from "@bullmq-visualizer/shared";
import { cn } from "@/lib/cn";
import { FEATURE_COPY } from "./featureCopy";
import { useEdition } from "./useEdition";

/**
 * Full-page placeholder shown in place of a locked Pro page.
 * The illustration is pure CSS so it stays crisp in both themes.
 */
export function LockedFeature({ feature }: { feature: ProFeature }) {
  const copy = FEATURE_COPY[feature];
  const { priceUsd, checkoutUrl } = useEdition();

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-8 px-6 py-10 lg:flex-row lg:items-center lg:gap-12">
      <div className="flex-1">
        <div className="mb-3 inline-flex items-center gap-1.5 rounded-full border border-pro/40 bg-pro/10 px-2.5 py-1 text-[11px] font-medium tracking-wider text-pro uppercase">
          <Lock className="size-3" aria-hidden />
          Pro feature
        </div>
        <h1 className="text-2xl font-semibold tracking-tight text-fg">{copy.title}</h1>
        <p className="mt-2 max-w-md text-sm leading-relaxed text-fg-muted">{copy.tagline}</p>
        <ul className="mt-5 space-y-2.5">
          {copy.bullets.map((b) => (
            <li key={b} className="flex items-start gap-2.5 text-[13px] text-fg">
              <Check className="mt-0.5 size-4 shrink-0 text-success" aria-hidden />
              <span>{b}</span>
            </li>
          ))}
        </ul>
        <div className="mt-7 flex flex-wrap items-center gap-3">
          <a
            href={checkoutUrl || "#"}
            target="_blank"
            rel="noreferrer noopener"
            aria-disabled={!checkoutUrl}
            className="inline-flex h-9 items-center gap-2 rounded-md bg-accent px-4 text-[13px] font-medium text-accent-fg hover:bg-accent-hover aria-disabled:pointer-events-none aria-disabled:opacity-50"
          >
            Unlock Pro · ${priceUsd} one-time
            <ExternalLink className="size-4" aria-hidden />
          </a>
          <Link
            to="/settings/license"
            className="inline-flex h-9 items-center gap-2 rounded-md border border-border-strong px-3 text-[13px] font-medium text-fg hover:bg-surface-2"
          >
            <KeyRound className="size-4" aria-hidden />I have a key
          </Link>
        </div>
        <p className="mt-3 text-xs text-fg-subtle">
          One key unlocks Alerts, Users &amp; roles, Folders and Flows. Perpetual, offline, no seat count.
        </p>
      </div>

      <div className="flex-1">
        <Illustration feature={feature} />
      </div>
    </div>
  );
}

function Illustration({ feature }: { feature: ProFeature }) {
  return (
    <div
      aria-hidden
      className="relative overflow-hidden rounded-xl border border-border bg-surface p-3 shadow-[var(--shadow)]"
    >
      <div className="mb-3 flex items-center gap-1.5">
        <span className="size-2 rounded-full bg-fg-subtle/40" />
        <span className="size-2 rounded-full bg-fg-subtle/40" />
        <span className="size-2 rounded-full bg-fg-subtle/40" />
        <span className="ml-3 h-2 w-24 rounded bg-surface-3" />
      </div>
      {feature === "alerts" && <AlertsArt />}
      {feature === "users" && <UsersArt />}
      {feature === "folders" && <FoldersArt />}
      {feature === "flows" && <FlowsArt />}
      <div className="pointer-events-none absolute inset-x-0 bottom-0 h-16 bg-gradient-to-t from-surface to-transparent" />
    </div>
  );
}

function Row({ className, children }: { className?: string; children?: React.ReactNode }) {
  return <div className={cn("flex items-center gap-2 rounded-md border border-border bg-bg/60 px-2.5 py-2", className)}>{children}</div>;
}
function Line({ w, className }: { w: string; className?: string }) {
  return <span className={cn("h-2 rounded bg-surface-3", className)} style={{ width: w }} />;
}

function AlertsArt() {
  return (
    <div className="space-y-2">
      <Row>
        <span className="status-dot pulse bg-danger" />
        <Line w="38%" className="bg-fg-muted/50" />
        <span className="ml-auto rounded bg-danger/15 px-1.5 py-0.5 text-[9px] font-medium text-danger">FIRING</span>
      </Row>
      <Row>
        <span className="status-dot bg-success" />
        <Line w="52%" />
        <span className="ml-auto rounded bg-success/15 px-1.5 py-0.5 text-[9px] font-medium text-success">OK</span>
      </Row>
      <Row>
        <span className="status-dot bg-success" />
        <Line w="30%" />
        <span className="ml-auto rounded bg-success/15 px-1.5 py-0.5 text-[9px] font-medium text-success">OK</span>
      </Row>
      <div className="mt-3 rounded-md border border-border bg-surface-2 p-2.5">
        <div className="mb-2 flex items-center gap-2">
          <span className="size-4 rounded bg-[#4A154B]" />
          <Line w="30%" className="bg-fg-muted/50" />
          <Line w="12%" className="ml-auto" />
        </div>
        <Line w="80%" className="mb-1.5" />
        <Line w="60%" />
      </div>
    </div>
  );
}

function UsersArt() {
  const roles = [
    ["admin", "bg-pro/15 text-pro"],
    ["operator", "bg-info/15 text-info"],
    ["operator", "bg-info/15 text-info"],
    ["viewer", "bg-surface-3 text-fg-muted"],
  ] as const;
  return (
    <div className="space-y-2">
      {roles.map(([r, cls], i) => (
        <Row key={i}>
          <span className="size-5 rounded-full bg-surface-3" />
          <div className="flex flex-col gap-1">
            <Line w={`${70 + i * 12}px`} className="bg-fg-muted/50" />
            <Line w={`${100 + i * 8}px`} className="h-1.5" />
          </div>
          <span className={cn("ml-auto rounded px-1.5 py-0.5 text-[9px] font-medium", cls)}>{r}</span>
        </Row>
      ))}
    </div>
  );
}

function FoldersArt() {
  return (
    <div className="space-y-1.5 text-[11px]">
      {[
        ["Payments", "bg-success", 0, 3],
        ["Checkout", "bg-success", 1, 2],
        ["Refunds", "bg-success", 1, 1],
        ["Notifications", "bg-info", 0, 4],
        ["Data pipeline", "bg-violet", 0, 2],
      ].map(([name, color, depth, n], i) => (
        <div key={i} className="flex items-center gap-2 rounded px-2 py-1" style={{ paddingLeft: 8 + (depth as number) * 16 }}>
          <span className={cn("size-3 rounded-sm", color as string)} />
          <span className="text-fg-muted">{name as string}</span>
          <span className="ml-auto rounded bg-surface-3 px-1 text-[9px] text-fg-subtle">{n as number}</span>
        </div>
      ))}
      <div className="ml-6 space-y-1 border-l border-border pl-3">
        <Line w="60%" />
        <Line w="45%" />
        <Line w="70%" />
      </div>
    </div>
  );
}

function FlowsArt() {
  const node = (x: number, y: number, label: string, tone = "bg-surface-2") => (
    <div
      className={cn("absolute flex h-9 w-28 flex-col justify-center rounded-md border border-border px-2", tone)}
      style={{ left: x, top: y }}
    >
      <span className="text-[10px] font-medium text-fg">{label}</span>
      <Line w="50%" className="mt-1 h-1.5" />
    </div>
  );
  return (
    <div className="relative h-52">
      <svg className="absolute inset-0 h-full w-full" fill="none" stroke="var(--fg-subtle)" strokeWidth={1.5}>
        <path d="M120 38 C 160 38, 160 98, 200 98" />
        <path d="M120 158 C 160 158, 160 98, 200 98" strokeDasharray="4 3" stroke="var(--accent)" />
        <path d="M312 98 C 350 98, 350 60, 380 60" />
        <path d="M312 98 C 350 98, 350 136, 380 136" />
      </svg>
      {node(8, 20, "ingest")}
      {node(8, 140, "backfill")}
      {node(200, 80, "process", "bg-accent/10")}
      {node(380, 42, "notify")}
      {node(380, 118, "archive")}
      <span className="absolute top-[60px] left-[150px] rounded bg-surface px-1 text-[9px] text-fg-subtle">×214</span>
    </div>
  );
}
