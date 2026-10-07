import { useState } from "react";
import { Link } from "react-router-dom";
import { FastForward, Layers, Pause, Play, Trash2 } from "lucide-react";
import { useGroupAction, useGroups, type GroupActionKind } from "@/api/hooks";
import { errorMessage } from "@/api/client";
import { useAuth } from "@/auth/AuthProvider";
import { routes } from "@/lib/routes";
import { toast } from "@/components/Toast";
import { Button } from "@/components/ui/Button";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { PromoteMatchingDialog } from "@/components/PromoteMatchingDialog";

/**
 * Everything that can be done to one BullMQ Pro group, on the queue page while it
 * is filtered by that group. The groups page only reaches the groups Pro indexes;
 * a group whose jobs are all delayed is in no index, but it can still be paused
 * (Pro records the pause and its jobs join it paused when they become due), have
 * its delayed jobs promoted, or be drained, so the actions live here too.
 */
export function GroupToolbar({ connectionId, queue, groupId }: { connectionId: string; queue: string; groupId: string }) {
  const { isOperator, isAdmin } = useAuth();
  // page size 1: only for the bullmqProApi flag
  const proApi = useGroups(connectionId, queue, { page: 1, pageSize: 1 }).data?.bullmqProApi ?? false;
  const groupAction = useGroupAction(connectionId, queue);
  const [confirmDrain, setConfirmDrain] = useState(false);
  const [promoteOpen, setPromoteOpen] = useState(false);
  const noProApi = proApi ? undefined : "Needs BullMQ Pro's package installed next to Bullpane";

  const run = (action: GroupActionKind) =>
    groupAction.mutate(
      { groupId, action },
      {
        onSuccess: () => toast.success(`Group ${groupId} ${action === "pause" ? "paused" : action === "resume" ? "resumed" : "drained"}`),
        onError: (e) => toast.error(errorMessage(e)),
        onSettled: () => setConfirmDrain(false),
      },
    );

  return (
    <div className="mb-3 flex flex-wrap items-center gap-2 rounded-md border border-border bg-surface-2/40 px-3 py-2 text-xs">
      <Layers className="size-3.5 text-pro" aria-hidden />
      <span className="text-fg-muted">
        Group <span className="font-mono text-fg">{groupId}</span>
      </span>
      <Link to={routes.group(connectionId, queue, groupId)} className="text-accent hover:underline">
        open group page
      </Link>
      {isOperator && (
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <Button size="xs" variant="secondary" leftIcon={<Pause />} disabled={!proApi || groupAction.isPending} title={noProApi} onClick={() => run("pause")}>
            Pause group
          </Button>
          <Button size="xs" variant="secondary" leftIcon={<Play />} disabled={!proApi || groupAction.isPending} title={noProApi} onClick={() => run("resume")}>
            Resume group
          </Button>
          <Button size="xs" variant="secondary" leftIcon={<FastForward />} disabled={!proApi} title={noProApi} onClick={() => setPromoteOpen(true)}>
            Promote all delayed
          </Button>
          {isAdmin && (
            <Button size="xs" variant="danger" leftIcon={<Trash2 />} disabled={!proApi || groupAction.isPending} title={noProApi} onClick={() => setConfirmDrain(true)}>
              Drain group
            </Button>
          )}
        </div>
      )}
      <ConfirmDialog
        open={confirmDrain}
        onClose={() => setConfirmDrain(false)}
        title="Drain group"
        description={`Remove every waiting job of group ${groupId} in ${queue} (BullMQ Pro's deleteGroup)? Its delayed jobs stay in the queue's delayed state. This cannot be undone.`}
        confirmText="Drain group"
        danger
        loading={groupAction.isPending}
        onConfirm={() => run("drain")}
      />
      <PromoteMatchingDialog open={promoteOpen} onClose={() => setPromoteOpen(false)} connectionId={connectionId} queue={queue} matches={[{ groupId }]} />
    </div>
  );
}
