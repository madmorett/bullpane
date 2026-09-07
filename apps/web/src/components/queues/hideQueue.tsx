/**
 * Hiding a queue, everywhere the action appears.
 *
 * Hiding is NOT obliterating, and the UI has to say so out loud, because the two
 * actions sit next to each other and only one is recoverable:
 *
 *   Hide       → the queue leaves the lists. Redis is untouched, every job stays,
 *                workers keep working, alerts keep firing. Reversible.
 *   Obliterate → deletes the queue and every job from Redis. Irreversible, and
 *                guarded by a type-the-name confirmation.
 *
 * So hiding gets no confirmation dialog at all: it gets a toast with "Undo",
 * which is faster to use and honest about the stakes.
 */
import { EyeOff } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import type { HiddenQueue } from "@bullmq-visualizer/shared";
import { api, errorMessage, seg } from "@/api/client";
import { qk, useSetQueueHidden } from "@/api/hooks";
import { toast } from "@/components/Toast";

/**
 * Copy used in tooltips and wherever hide sits next to obliterate. The two must
 * never read as variations of the same thing.
 */
export const HIDE_HINT = "only leaves the list · jobs untouched · reversible";
export const HIDE_TOOLTIP =
  "Hide this queue from the lists. Nothing is deleted: the jobs, the workers and the alerts stay exactly as they are, and you can bring it back at any time. (Not to be confused with Obliterate, which deletes the queue and all its jobs for good.)";

export { EyeOff as HideIcon };

const hiddenToastDescription = "Removed from the lists only. No job was deleted.";

/**
 * Hide / unhide on ONE connection.
 * `useSetQueueHidden` already invalidates the queue lists, so the queue vanishes
 * from (or returns to) the sidebar, the cards and the table on the next refresh.
 */
export function useHideQueue(connectionId: string) {
  const mutation = useSetQueueHidden(connectionId);

  const unhide = (queue: string, opts: { silent?: boolean } = {}) =>
    mutation.mutate(
      { queue, hidden: false },
      {
        onSuccess: () => {
          if (!opts.silent) toast.success(`${queue} is visible again`);
        },
        onError: (e) => toast.error(errorMessage(e)),
      },
    );

  const hide = (queue: string) =>
    mutation.mutate(
      { queue, hidden: true },
      {
        onSuccess: () =>
          toast.undoable(`${queue} hidden`, { label: "Undo", onClick: () => unhide(queue, { silent: true }) }, hiddenToastDescription),
        onError: (e) => toast.error(errorMessage(e)),
      },
    );

  return {
    hide,
    unhide,
    isPending: mutation.isPending,
    pendingQueue: mutation.isPending ? (mutation.variables?.queue ?? null) : null,
  };
}

/**
 * Hide / unhide across SEVERAL connections — the overview lists queues from all
 * of them, so the connection is part of the argument rather than of the hook.
 * A plain async call instead of a react-query mutation, because there is no
 * single connection id to key a mutation by; invalidation is done by hand.
 */
export function useHideQueueAnywhere() {
  const qc = useQueryClient();

  const set = async (connectionId: string, queue: string, hidden: boolean): Promise<void> => {
    const data = hidden
      ? await api.post<HiddenQueue[]>(`/connections/${seg(connectionId)}/hidden-queues`, { queueName: queue })
      : await api.del<HiddenQueue[]>(`/connections/${seg(connectionId)}/hidden-queues/${seg(queue)}`);
    qc.setQueryData(qk.hiddenQueues(connectionId), data);
    qc.invalidateQueries({ queryKey: qk.queues(connectionId) });
    qc.invalidateQueries({ queryKey: qk.overview(connectionId) });
  };

  const unhide = (connectionId: string, queue: string, opts: { silent?: boolean } = {}) =>
    set(connectionId, queue, false).then(
      () => {
        if (!opts.silent) toast.success(`${queue} is visible again`);
      },
      (e: unknown) => toast.error(errorMessage(e)),
    );

  const hide = (connectionId: string, queue: string) =>
    set(connectionId, queue, true).then(
      () =>
        toast.undoable(
          `${queue} hidden`,
          { label: "Undo", onClick: () => void unhide(connectionId, queue, { silent: true }) },
          hiddenToastDescription,
        ),
      (e: unknown) => toast.error(errorMessage(e)),
    );

  return { hide, unhide };
}
