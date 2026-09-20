import { useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { Bell, Folder as FolderIcon, Pencil, Plus, Wand2, X } from "lucide-react";
import type { Folder, FolderQueueRef } from "@bullpane/shared";
import { routes } from "@/lib/routes";
import { formatNumber } from "@/lib/format";
import { entryKey, matchesFilter, type QueueEntry } from "@/lib/groupQueues";
import { useTableState } from "@/lib/useTableState";
import { useAllQueues, useFolders, useSetFolderQueues } from "@/api/hooks";
import { errorMessage } from "@/api/client";
import { useAuth } from "@/auth/AuthProvider";
import { useEdition } from "@/edition/useEdition";
import { LockedFeature } from "@/edition/LockedFeature";
import { toast } from "@/components/Toast";
import { Page } from "@/components/layout/AppShell";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { EmptyState } from "@/components/ui/EmptyState";
import { PageSpinner } from "@/components/ui/Spinner";
import { QueueCard } from "@/components/queues/QueueCard";
import { QueueCardSkeleton } from "@/components/queues/QueueCardGrid";
import { QueueFilterInput } from "@/components/queues/QueueFilterInput";
import { DEFAULT_QUEUE_SORT, QUEUE_TABLE_KEYS, QueuesTable } from "@/components/queues/QueuesTable";
import { AlertDialog } from "@/pages/alerts/AlertDialog";
import { FolderMetrics } from "./FolderMetrics";
import { QueuePickerDialog } from "./QueuePickerDialog";
import { ImportMatchingDialog } from "./ImportMatchingDialog";
import { EditFolderDialog } from "./EditFolderDialog";

export function FolderPage() {
  const { has } = useEdition();
  if (!has("folders")) return <LockedFeature feature="folders" />;
  return <FolderDashboard />;
}

type DialogKind = "edit" | "add" | "import" | "alert";

function FolderDashboard() {
  const { folderId = "" } = useParams();
  const { isOperator } = useAuth();
  const { has, gate } = useEdition();
  const folders = useFolders();
  const { byConnection, isLoading: queuesLoading } = useAllQueues();
  const setQueues = useSetFolderQueues();
  const [dialog, setDialog] = useState<DialogKind | null>(null);
  const { sort, setSort, filter, setFilter } = useTableState(`folder.${folderId}`, DEFAULT_QUEUE_SORT, QUEUE_TABLE_KEYS);

  const list = folders.data ?? [];
  const folder = list.find((f) => f.id === folderId) ?? null;

  /**
   * Resolve the folder's refs against the live queue lists. A ref whose queue
   * is gone (renamed, obliterated, connection removed) resolves to nothing and
   * is surfaced separately rather than silently dropped.
   */
  const { entries, missing } = useMemo(() => {
    const found: QueueEntry[] = [];
    const gone: FolderQueueRef[] = [];
    for (const ref of folder?.queues ?? []) {
      const conn = byConnection.find((b) => b.connection.id === ref.connectionId);
      const queue = conn?.queues.find((q) => q.name === ref.queueName);
      if (conn && queue) found.push({ connection: conn.connection, queue });
      else gone.push(ref);
    }
    return { entries: found, missing: gone };
  }, [folder, byConnection]);

  const visible = useMemo(() => entries.filter((e) => matchesFilter(e, filter)), [entries, filter]);

  const writeQueues = (queues: FolderQueueRef[], success: string, close = true) => {
    if (!folder) return;
    setQueues.mutate(
      { id: folder.id, input: { queues } },
      {
        onSuccess: () => {
          toast.success(success);
          if (close) setDialog(null);
        },
        onError: (e) => toast.error(errorMessage(e)),
      },
    );
  };

  const removeQueue = (ref: FolderQueueRef) =>
    writeQueues(
      (folder?.queues ?? []).filter((q) => !(q.connectionId === ref.connectionId && q.queueName === ref.queueName)),
      `${ref.queueName} removed from ${folder?.name ?? "folder"}`,
      false,
    );

  if (folders.isLoading) {
    return (
      <Page wide>
        <PageSpinner />
      </Page>
    );
  }

  if (!folder) {
    return (
      <Page wide>
        <EmptyState
          icon={<FolderIcon />}
          title="Folder not found"
          description="It may have been deleted."
          action={
            <Link to={routes.folders} className="text-accent hover:underline">
              Back to folders
            </Link>
          }
        />
      </Page>
    );
  }

  const parent = folder.parentId ? list.find((f) => f.id === folder.parentId) : null;
  const empty = folder.queues.length === 0;

  return (
    <Page wide>
      {/* Header */}
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2.5">
            <span
              className="size-3 shrink-0 rounded-full ring-2 ring-inset ring-white/10"
              style={{ background: folder.color ?? "var(--fg-subtle)" }}
              aria-hidden
            />
            <h1 className="truncate text-lg font-semibold tracking-tight">{folder.name}</h1>
          </div>
          <p className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-fg-muted">
            {parent && (
              <>
                <Link to={`/folders/${encodeURIComponent(parent.id)}`} className="hover:underline">
                  {parent.name}
                </Link>
                <span className="text-fg-subtle">/</span>
              </>
            )}
            <span className="num">
              {formatNumber(folder.queues.length)} {folder.queues.length === 1 ? "queue" : "queues"}
            </span>
            {missing.length > 0 && (
              <span className="text-state-waiting" title={missing.map((m) => m.queueName).join(", ")}>
                · {formatNumber(missing.length)} not found
              </span>
            )}
            <span className="text-fg-subtle">·</span>
            <Link to={routes.folders} className="hover:underline">
              Manage folders
            </Link>
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {isOperator && (
            <Button size="sm" variant="secondary" leftIcon={<Pencil />} onClick={() => setDialog("edit")}>
              Edit
            </Button>
          )}
          {isOperator && (
            <Button size="sm" variant="secondary" leftIcon={<Wand2 />} onClick={() => setDialog("import")} title="Import queues matching a pattern">
              Import matching
            </Button>
          )}
          {isOperator && (
            <Button size="sm" variant="primary" leftIcon={<Plus />} onClick={() => setDialog("add")}>
              Add queue
            </Button>
          )}
          <Button size="sm" leftIcon={<Bell />} onClick={() => gate("alerts", () => setDialog("alert"))} title="Alert on every queue in this folder">
            Create alert
          </Button>
        </div>
      </div>

      {/* Folder-level aggregate */}
      <FolderMetrics entries={entries} className="mb-4" />

      {empty ? (
        <div className="card">
          <EmptyState
            icon={<FolderIcon />}
            title="This folder is empty"
            description="Add queues by hand, or import every queue whose name matches a pattern like channels* or *-retry."
            action={
              isOperator && (
                <>
                  <Button variant="primary" leftIcon={<Plus />} onClick={() => setDialog("add")}>
                    Add queue
                  </Button>
                  <Button leftIcon={<Wand2 />} onClick={() => setDialog("import")}>
                    Import matching queues
                  </Button>
                </>
              )
            }
          />
        </div>
      ) : (
        <section className="space-y-3" aria-label="Queues in this folder">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-xs font-semibold tracking-wider text-fg-subtle uppercase">Queues</h2>
            <div className="flex items-center gap-2">
              <QueueFilterInput value={filter} onChange={setFilter} aria-label="Filter queues in this folder" />
              <span className="num whitespace-nowrap text-xs text-fg-subtle">
                {visible.length} of {entries.length}
              </span>
            </div>
          </div>

          {queuesLoading && entries.length === 0 ? (
            <QueueCardSkeleton />
          ) : visible.length > 0 ? (
            <div className="grid gap-2" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(230px, 1fr))" }}>
              {visible.map((e) => (
                <RemovableQueueCard
                  key={entryKey(e)}
                  entry={e}
                  onRemove={isOperator ? () => removeQueue({ connectionId: e.connection.id, queueName: e.queue.name }) : undefined}
                  removing={setQueues.isPending}
                />
              ))}
            </div>
          ) : null}

          <div className="card overflow-hidden">
            <QueuesTable
              rows={visible}
              showConnection
              sort={sort}
              onSort={setSort}
              message={
                queuesLoading && entries.length === 0
                  ? "Loading queues…"
                  : filter
                    ? "No queue matches the filter"
                    : "None of this folder's queues could be resolved on their connections."
              }
            />
          </div>

          {missing.length > 0 && (
            <div className="card px-4 py-3">
              <h3 className="mb-1.5 text-[11px] font-semibold tracking-wider text-fg-subtle uppercase">Not found on their connection</h3>
              <ul className="flex flex-wrap gap-2">
                {missing.map((m) => (
                  <li key={`${m.connectionId}/${m.queueName}`} className="flex items-center gap-1.5 rounded border border-border bg-surface-2 px-2 py-1 text-xs">
                    <span className="font-mono text-fg-muted line-through">{m.queueName}</span>
                    <Badge variant="outline" size="xs">
                      {byConnection.find((b) => b.connection.id === m.connectionId)?.connection.name ?? m.connectionId}
                    </Badge>
                    {isOperator && (
                      <Button size="icon-xs" variant="ghost" className="hover:text-danger" aria-label={`Remove ${m.queueName}`} onClick={() => removeQueue(m)}>
                        <X />
                      </Button>
                    )}
                  </li>
                ))}
              </ul>
              <p className="mt-2 text-[11px] text-fg-subtle">
                These queues are referenced by the folder but were not discovered on their connection — renamed, obliterated, or the connection is down.
              </p>
            </div>
          )}
        </section>
      )}

      {/* Dialogs */}
      {isOperator && dialog === "edit" && <EditFolderDialog open onClose={() => setDialog(null)} folder={folder} allFolders={list} />}
      {isOperator && (
        <QueuePickerDialog
          open={dialog === "add"}
          onClose={() => setDialog(null)}
          initial={folder.queues}
          saving={setQueues.isPending}
          onSave={(queues) => writeQueues(queues, "Folder updated")}
          title={`Add queues to ${folder.name}`}
        />
      )}
      {isOperator && (
        <ImportMatchingDialog
          open={dialog === "import"}
          onClose={() => setDialog(null)}
          existing={folder.queues}
          saving={setQueues.isPending}
          onImport={(queues) => writeQueues(queues, `Imported into ${folder.name}`)}
        />
      )}
      {dialog === "alert" && has("alerts") && (
        <AlertDialog open onClose={() => setDialog(null)} alert={null} initialScope={{ type: "folder", folderId: folder.id }} />
      )}
    </Page>
  );
}

/**
 * QueueCard with a remove affordance. The card itself uses a stretched link
 * (`after:inset-0`), so the button needs its own stacking context to stay
 * clickable above it — same trick the card's own search icon uses.
 */
function RemovableQueueCard({ entry, onRemove, removing }: { entry: QueueEntry; onRemove?: () => void; removing: boolean }) {
  return (
    <div className="group/card relative">
      <QueueCard entry={entry} showConnection />
      {onRemove && (
        <Button
          size="icon-xs"
          variant="ghost"
          disabled={removing}
          onClick={onRemove}
          aria-label={`Remove ${entry.queue.name} from this folder`}
          title="Remove from folder"
          /* Top-right corner, left of the card search icon. It used to sit at
             bottom-1, covering the success-rate bar. */
          className="absolute top-2 right-8 z-10 bg-surface/90 opacity-0 backdrop-blur-sm transition-opacity group-hover/card:opacity-100 focus-visible:opacity-100 hover:text-danger"
        >
          <X />
        </Button>
      )}
    </div>
  );
}
