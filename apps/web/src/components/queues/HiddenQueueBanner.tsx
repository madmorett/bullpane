/**
 * "This queue is hidden" — the direct-URL case.
 *
 * Hiding removes a queue from the LISTS, not from the app. A bookmark, a link in
 * an incident channel, or an alert notification pointing at
 * /c/:cid/q/:name must still open the real queue page with every tab working.
 * So the page renders normally and this banner is added on top: it explains why
 * the queue is not in the sidebar, and offers the one-click way back.
 *
 * It is rendered from the AppShell rather than from inside the queue page,
 * because the shell already knows the route and every queue sub-route
 * (jobs, metrics, schedulers, groups, a single job) gets the notice for free.
 */
import { Eye, EyeOff } from "lucide-react";
import { useHiddenQueues } from "@/api/hooks";
import { useAuth } from "@/auth/AuthProvider";
import { Button } from "@/components/ui/Button";
import { RelativeTime } from "@/components/ui/RelativeTime";
import { useHideQueue } from "./hideQueue";

export function HiddenQueueBanner({ connectionId, queueName }: { connectionId: string; queueName: string }) {
  const { isOperator } = useAuth();
  const hidden = useHiddenQueues(connectionId);
  const hiding = useHideQueue(connectionId);

  const row = hidden.data?.find((h) => h.queueName === queueName);
  if (!row) return null;

  return (
    <div
      role="status"
      className="mx-auto flex w-full max-w-none flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-warning/40 bg-warning/10 px-5 py-2 text-xs text-fg"
    >
      <EyeOff className="size-3.5 shrink-0 text-warning" aria-hidden />
      <span>
        <span className="font-medium">This queue is hidden.</span> It does not appear in the sidebar, the cards or the tables.
        Nothing was deleted — the jobs, the workers and the alerts are untouched.
      </span>
      <span className="text-fg-subtle">
        hidden <RelativeTime value={row.hiddenAt} className="text-xs" />
        {row.hiddenByName && ` by ${row.hiddenByName}`}
      </span>
      {isOperator && (
        <Button
          size="xs"
          variant="secondary"
          className="ml-auto"
          leftIcon={<Eye />}
          loading={hiding.pendingQueue === queueName}
          onClick={() => hiding.unhide(queueName)}
        >
          Show again
        </Button>
      )}
    </div>
  );
}
