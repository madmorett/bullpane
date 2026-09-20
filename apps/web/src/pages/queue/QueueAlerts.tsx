/**
 * The alerts watching THIS queue, shown on the queue page.
 *
 * A queue is covered two ways:
 *  - directly, by a queue-scoped alert naming it, and
 *  - indirectly, by a folder-scoped alert whose folder contains it.
 * Both are resolved client-side from data the app already has (`/alerts` and
 * `/folders` are cached and polled for the sidebar), so this adds no request.
 *
 * In the free edition `alerts` is locked and `/alerts` would 402, so the hooks
 * stay disabled and this renders nothing at all.
 */
import { useMemo, useState } from "react";
import { Bell, BellRing, Pencil, Plus } from "lucide-react";
import { Link } from "react-router-dom";
import type { Alert } from "@bullpane/shared";
import { useAlerts, useFolders } from "@/api/hooks";
import { useEdition } from "@/edition/useEdition";
import { useAuth } from "@/auth/AuthProvider";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { RelativeTime } from "@/components/ui/RelativeTime";
import { Tooltip } from "@/components/ui/Tooltip";
import { routes } from "@/lib/routes";
import { cn } from "@/lib/cn";
import { AlertDialog } from "@/pages/alerts/AlertDialog";
import { describeCondition } from "@/pages/alerts/AlertsPage";

export interface QueueAlertMatch {
  alert: Alert;
  /** how this queue is covered: named directly, or via a folder */
  via: { kind: "queue" } | { kind: "folder"; folderId: string; folderName: string };
}

/**
 * Every alert covering `queueName` on `connectionId`, firing ones first.
 * Exported so the page header can show a count without rendering the panel.
 */
export function useQueueAlerts(connectionId: string, queueName: string): {
  matches: QueueAlertMatch[];
  firing: number;
  enabled: boolean;
} {
  const { has } = useEdition();
  const enabled = has("alerts");
  const alerts = useAlerts(enabled);
  const folders = useFolders(enabled && has("folders"));

  const matches = useMemo<QueueAlertMatch[]>(() => {
    const all = alerts.data ?? [];
    if (all.length === 0) return [];
    const folderList = folders.data ?? [];

    // folderId -> name, but only for folders that actually contain this queue
    const covering = new Map<string, string>();
    for (const f of folderList) {
      if (f.queues.some((q) => q.connectionId === connectionId && q.queueName === queueName)) {
        covering.set(f.id, f.name);
      }
    }

    const out: QueueAlertMatch[] = [];
    for (const alert of all) {
      if (alert.scope.type === "queue") {
        if (alert.scope.connectionId === connectionId && alert.scope.queueName === queueName) {
          out.push({ alert, via: { kind: "queue" } });
        }
      } else {
        const folderName = covering.get(alert.scope.folderId);
        if (folderName !== undefined) {
          out.push({ alert, via: { kind: "folder", folderId: alert.scope.folderId, folderName } });
        }
      }
    }
    // firing first, then enabled, then by name
    return out.sort(
      (a, b) =>
        Number(b.alert.firing) - Number(a.alert.firing) ||
        Number(b.alert.enabled) - Number(a.alert.enabled) ||
        a.alert.name.localeCompare(b.alert.name),
    );
  }, [alerts.data, folders.data, connectionId, queueName]);

  return { matches, firing: matches.filter((m) => m.alert.firing).length, enabled };
}

/** Compact "N alerts · 1 firing" pill for the page header. */
export function QueueAlertsPill({ matches, firing }: { matches: QueueAlertMatch[]; firing: number }) {
  if (matches.length === 0) return null;
  const label = `${matches.length} alert${matches.length === 1 ? "" : "s"}`;
  return (
    <Tooltip content={firing > 0 ? `${firing} of ${matches.length} firing right now` : "Watching this queue"}>
      <Link
        to={routes.alerts}
        className={cn(
          "inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[11px] font-medium transition-colors",
          firing > 0
            ? "border-danger/40 bg-danger/10 text-danger hover:bg-danger/20"
            : "border-border text-fg-muted hover:bg-surface-hover hover:text-fg",
        )}
      >
        {firing > 0 ? <BellRing className="size-3" /> : <Bell className="size-3" />}
        {firing > 0 ? `${firing} firing` : label}
      </Link>
    </Tooltip>
  );
}

/**
 * The panel under the queue header. Renders nothing in the free edition or when
 * no alert covers this queue — an empty box on every queue page would be noise.
 */
export function QueueAlerts({
  connectionId,
  queueName,
  matches,
  onCreate,
}: {
  connectionId: string;
  queueName: string;
  matches: QueueAlertMatch[];
  onCreate: () => void;
}) {
  const { isOperator } = useAuth();
  const [editing, setEditing] = useState<Alert | null>(null);
  if (matches.length === 0) return null;

  return (
    <section className="rounded-md border border-border bg-surface" aria-label="Alerts watching this queue">
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <Bell className="size-3.5 text-fg-muted" />
        <h2 className="text-[11px] font-semibold uppercase tracking-wider text-fg-muted">Alerts on this queue</h2>
        <span className="text-[11px] text-fg-subtle">{matches.length}</span>
        <div className="ml-auto flex items-center gap-2">
          <Link to={routes.alerts} className="text-[11px] text-accent hover:underline">
            Manage all
          </Link>
          {isOperator && (
            <Button size="xs" variant="ghost" leftIcon={<Plus />} onClick={onCreate}>
              Add
            </Button>
          )}
        </div>
      </div>

      <ul className="divide-y divide-border">
        {matches.map(({ alert, via }) => (
          <li key={alert.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-[12px]">
            <span className="shrink-0">
              {alert.firing ? (
                <Badge variant="danger" className="gap-1">
                  <BellRing className="size-3" /> firing
                </Badge>
              ) : alert.enabled ? (
                <Badge variant="success">ok</Badge>
              ) : (
                <Badge variant="neutral">off</Badge>
              )}
            </span>

            <span className={cn("font-medium", !alert.enabled && "text-fg-muted")}>{alert.name}</span>

            <span className="font-mono text-[11px] text-fg-muted">{describeCondition(alert.condition)}</span>

            {via.kind === "folder" && (
              <Tooltip content="This alert watches every queue in the folder">
                <Link
                  to={routes.folder(via.folderId)}
                  className="rounded border border-border px-1 text-[10px] text-fg-muted hover:text-fg"
                >
                  via folder {via.folderName}
                </Link>
              </Tooltip>
            )}

            <span className="ml-auto flex items-center gap-3 text-[11px] text-fg-subtle">
              <span>
                {alert.lastFiredAt ? (
                  <>
                    last fired <RelativeTime value={alert.lastFiredAt} />
                  </>
                ) : (
                  "never fired"
                )}
              </span>
              {isOperator && (
                <button
                  type="button"
                  className="text-fg-muted hover:text-fg"
                  onClick={() => setEditing(alert)}
                  title="Edit alert"
                  aria-label={`Edit ${alert.name}`}
                >
                  <Pencil className="size-3.5" />
                </button>
              )}
            </span>
          </li>
        ))}
      </ul>

      {editing && <AlertDialog open onClose={() => setEditing(null)} alert={editing} />}
      <span className="sr-only">{`Alerts watching ${queueName} on connection ${connectionId}`}</span>
    </section>
  );
}
