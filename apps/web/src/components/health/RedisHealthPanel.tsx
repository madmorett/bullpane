import { Link } from "react-router-dom";
import { Activity, ExternalLink, Pause, Play, ServerCrash } from "lucide-react";
import { cn } from "@/lib/cn";
import { routes } from "@/lib/routes";
import { errorMessage } from "@/api/client";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { Tooltip } from "@/components/ui/Tooltip";
import { HealthConnectionCard } from "./HealthConnectionCard";
import { aggregate, useHealthMonitor } from "./useHealthMonitor";

export const HEALTH_PANEL_ID = "redis-health";

export interface RedisHealthPanelProps {
  /** the /health page variant: bigger charts, no "Open monitor" link */
  big?: boolean;
  className?: string;
  /** hide the h2 + link row (the /health page has its own PageHeader) */
  headless?: boolean;
}

/**
 * Live Redis health, one card per connection.
 *
 * Everything numeric here comes from the server: rates, percentages and
 * warnings are derived once in apps/server/src/services/health.ts so that
 * every open tab agrees and so the UI never invents a threshold of its own.
 */
export function RedisHealthPanel({ big, className, headless }: RedisHealthPanelProps) {
  const { health, paused, setPaused, isLoading, error } = useHealthMonitor();
  const agg = aggregate(health);

  return (
    <section id={HEALTH_PANEL_ID} aria-label="Redis health" className={cn("scroll-mt-16", className)}>
      {!headless && (
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <h2 className="flex items-center gap-1.5 text-sm font-semibold text-fg">
            <Activity className="size-4 text-fg-subtle" aria-hidden />
            Redis health
          </h2>
          {agg.critical > 0 && (
            <Badge variant="danger" size="xs">
              {agg.critical} critical
            </Badge>
          )}
          {agg.warn > 0 && (
            <Badge variant="warning" size="xs">
              {agg.warn} warning{agg.warn === 1 ? "" : "s"}
            </Badge>
          )}
          {agg.critical === 0 && agg.warn === 0 && health.length > 0 && !paused && (
            <Badge variant="success" size="xs" dot>
              all clear
            </Badge>
          )}
          <div className="ml-auto flex items-center gap-2">
            {!big && (
              <Link
                to={routes.health}
                className="inline-flex items-center gap-1 text-[11px] text-accent hover:underline"
              >
                Open monitor
                <ExternalLink className="size-3" aria-hidden />
              </Link>
            )}
            <PauseToggle paused={paused} onChange={setPaused} />
          </div>
        </div>
      )}

      {headless && (
        <div className="mb-2 flex items-center justify-end">
          <PauseToggle paused={paused} onChange={setPaused} />
        </div>
      )}

      {paused && (
        <p className="mb-2 flex items-center gap-2 rounded-md border border-warning/40 bg-warning/10 px-2.5 py-1.5 text-xs text-warning">
          <Pause className="size-3.5 shrink-0" aria-hidden />
          Monitoring paused. The dashboard is sending no INFO commands to Redis. Numbers below are the last
          frame received.
        </p>
      )}

      {error != null && !paused && (
        <p className="mb-2 rounded-md border border-danger/40 bg-danger/10 px-2.5 py-1.5 text-xs text-danger">
          Could not load health: {errorMessage(error)}
        </p>
      )}

      {isLoading && health.length === 0 ? (
        <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(360px, 1fr))" }}>
          {[0, 1].map((i) => (
            <div key={i} className="card h-64 animate-pulse" />
          ))}
        </div>
      ) : health.length === 0 ? (
        <div className="card">
          <EmptyState
            compact
            icon={<ServerCrash />}
            title="Nothing to monitor"
            description="Health shows up once a Redis connection is configured."
          />
        </div>
      ) : (
        <div
          className="grid gap-3"
          style={{ gridTemplateColumns: `repeat(auto-fit, minmax(${big ? 480 : 360}px, 1fr))` }}
        >
          {health.map((h) => (
            <HealthConnectionCard key={h.connectionId} health={h} big={big} paused={paused} />
          ))}
        </div>
      )}

      <HealthFootnote />
    </section>
  );
}

function PauseToggle({ paused, onChange }: { paused: boolean; onChange: (next: boolean) => void }) {
  return (
    <Tooltip
      content={
        paused
          ? "Resume polling. One INFO per connection every 3s."
          : "Stop the dashboard's own Redis traffic immediately."
      }
    >
      <Button
        size="xs"
        variant={paused ? "primary" : "ghost"}
        leftIcon={paused ? <Play /> : <Pause />}
        aria-pressed={paused}
        onClick={() => onChange(!paused)}
      >
        {paused ? "Resume monitoring" : "Pause monitoring"}
      </Button>
    </Tooltip>
  );
}

/** What this view costs the Redis it is watching. Said out loud, on purpose. */
export function HealthFootnote() {
  return (
    <p className="mt-2 text-[11px] leading-relaxed text-fg-subtle">
      One INFO command per connection every 3s. INFO is O(1). The server shares and rate-limits the
      sample, so extra browser tabs add no extra load. See{" "}
      <code className="font-mono text-fg-muted">docs/PRODUCTION-TRIAL.md</code> before pointing this at a
      production Redis.
    </p>
  );
}
