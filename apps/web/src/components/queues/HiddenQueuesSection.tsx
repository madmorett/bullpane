/**
 * "Hidden queues (N)" — the way back.
 *
 * It lives at the bottom of the connection page, collapsed, because that is the
 * page that owns the list a hidden queue was removed FROM. Putting it in
 * Settings would separate the action from its consequence, and putting it in the
 * sidebar would reintroduce exactly the noise the user asked to get rid of.
 * Collapsed by default, and the header carries the count so it never becomes an
 * invisible drawer of forgotten decisions.
 *
 * Rendered for everyone, not just operators: a viewer needs to be able to see
 * that a queue exists and is being hidden from them, and by whom. Only the
 * "Show again" button is operator-gated.
 */
import { ChevronDown, ChevronRight, Eye, EyeOff } from "lucide-react";
import { Link } from "react-router-dom";
import type { HiddenQueue } from "@bullmq-visualizer/shared";
import { cn } from "@/lib/cn";
import { routes } from "@/lib/routes";
import { usePersistedToggle } from "@/lib/usePersistedToggle";
import { Button } from "@/components/ui/Button";
import { RelativeTime } from "@/components/ui/RelativeTime";

export function HiddenQueuesSection({
  connectionId,
  hidden,
  canUnhide,
  onUnhide,
  pendingQueue,
  className,
  forceOpen,
}: {
  connectionId: string;
  hidden: HiddenQueue[];
  canUnhide: boolean;
  onUnhide: (queue: string) => void;
  pendingQueue?: string | null;
  className?: string;
  /** open on mount — used when the user arrives from the "N hidden" link */
  forceOpen?: boolean;
}) {
  const [open, toggle] = usePersistedToggle(`hiddenQueues.${connectionId}`, false);
  const expanded = open || !!forceOpen;

  if (hidden.length === 0) return null;

  return (
    <section className={cn("card overflow-hidden", className)} aria-label="Hidden queues" id="hidden-queues">
      <button
        type="button"
        onClick={toggle}
        aria-expanded={expanded}
        className="flex w-full items-center gap-2 px-4 py-2.5 text-left hover:bg-surface-2"
      >
        {expanded ? <ChevronDown className="size-3.5 text-fg-subtle" aria-hidden /> : <ChevronRight className="size-3.5 text-fg-subtle" aria-hidden />}
        <EyeOff className="size-3.5 text-fg-subtle" aria-hidden />
        <h2 className="text-xs font-semibold tracking-wider text-fg-subtle uppercase">
          Hidden queues <span className="num">({hidden.length})</span>
        </h2>
        <span className="ml-auto text-[11px] text-fg-subtle">
          Not counted in the totals above · jobs untouched
        </span>
      </button>

      {expanded && (
        <ul className="divide-y divide-border border-t border-border">
          {hidden.map((h) => (
            <li key={h.queueName} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2">
              {/* A hidden queue is still fully reachable by URL. */}
              <Link to={routes.queue(connectionId, h.queueName)} className="font-mono text-xs font-medium hover:underline">
                {h.queueName}
              </Link>
              <span className="text-[11px] text-fg-subtle">
                hidden <RelativeTime value={h.hiddenAt} className="text-[11px]" />
                {h.hiddenByName && ` by ${h.hiddenByName}`}
              </span>
              {canUnhide && (
                <Button
                  size="xs"
                  variant="ghost"
                  className="ml-auto"
                  leftIcon={<Eye />}
                  loading={pendingQueue === h.queueName}
                  onClick={() => onUnhide(h.queueName)}
                  title="Put this queue back in the lists"
                >
                  Show again
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
