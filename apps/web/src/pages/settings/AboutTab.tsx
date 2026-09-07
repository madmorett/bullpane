import { ExternalLink } from "lucide-react";
import { formatUptime } from "@/lib/format";
import { useHealth } from "@/api/hooks";
import { useEdition } from "@/edition/useEdition";
import { Logo } from "@/components/layout/Sidebar";
import { Skeleton } from "@/components/ui/Spinner";

export function AboutTab() {
  const health = useHealth();
  const { edition, checkoutUrl } = useEdition();

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <div className="card p-4">
        <div className="flex items-center gap-3">
          <Logo className="size-9" />
          <div>
            <h2 className="text-sm font-semibold">Bullpane</h2>
            <p className="text-xs text-fg-muted">Self-hosted dashboard for BullMQ and BullMQ Pro.</p>
          </div>
        </div>
        <dl className="mt-4 grid grid-cols-2 gap-3 border-t border-border pt-4 text-xs">
          <div>
            <dt className="text-[10px] tracking-wide text-fg-subtle uppercase">Server version</dt>
            <dd className="font-mono text-fg">{health.data ? health.data.version : health.isError ? "unknown" : <Skeleton />}</dd>
          </div>
          <div>
            <dt className="text-[10px] tracking-wide text-fg-subtle uppercase">Server uptime</dt>
            <dd className="text-fg">{health.data ? formatUptime(health.data.uptime) : health.isError ? "unknown" : <Skeleton />}</dd>
          </div>
          <div>
            <dt className="text-[10px] tracking-wide text-fg-subtle uppercase">Edition</dt>
            <dd className="text-fg">
              {edition.tier}
              {edition.demo && " (demo)"}
            </dd>
          </div>
          <div>
            <dt className="text-[10px] tracking-wide text-fg-subtle uppercase">UI build</dt>
            <dd className="font-mono text-fg">{import.meta.env.MODE}</dd>
          </div>
        </dl>
      </div>

      <div className="card p-4">
        <h3 className="mb-2 text-xs font-semibold tracking-wider text-fg-subtle uppercase">Links</h3>
        <ul className="space-y-1.5 text-[13px]">
          <li>
            <a href="https://docs.bullmq.io" target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-1.5 text-accent hover:underline">
              BullMQ documentation <ExternalLink className="size-3.5" />
            </a>
          </li>
          {checkoutUrl && (
            <li>
              <a href={checkoutUrl} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-1.5 text-accent hover:underline">
                Buy a Pro license (from ${edition.pricing.monthlyUsd}/mo) <ExternalLink className="size-3.5" />
              </a>
            </li>
          )}
          <li>
            <a href="/api/health" target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-1.5 text-accent hover:underline">
              API health <ExternalLink className="size-3.5" />
            </a>
          </li>
        </ul>
        <h3 className="mt-5 mb-2 text-xs font-semibold tracking-wider text-fg-subtle uppercase">How it reads Redis</h3>
        <ul className="list-disc space-y-1 pl-4 text-xs text-fg-muted">
          <li>
            Discovery via <span className="font-mono">SCAN</span>, never <span className="font-mono">KEYS</span>; cached 30 s.
          </li>
          <li>Counts, pages and details are single Lua round trips per queue.</li>
          <li>Payloads are truncated inside Redis for list views.</li>
          <li>Writes go through the official bullmq library.</li>
        </ul>
      </div>
    </div>
  );
}
