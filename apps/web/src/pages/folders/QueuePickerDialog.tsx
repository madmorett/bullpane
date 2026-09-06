import { useEffect, useState } from "react";
import { Search } from "lucide-react";
import type { FolderQueueRef } from "@bullmq-visualizer/shared";
import { useAllQueues } from "@/api/hooks";
import { Dialog } from "@/components/ui/Dialog";
import { Button } from "@/components/ui/Button";
import { Checkbox, Input } from "@/components/ui/Input";
import { PageSpinner } from "@/components/ui/Spinner";

/**
 * Searchable, multi-select queue picker across every connection.
 * Lifted out of FoldersPage so the folder detail page reuses the same one.
 */
export function QueuePickerDialog({
  open,
  onClose,
  initial,
  onSave,
  saving,
  title = "Assign queues",
  description = "Pick queues from any connection. A queue can live in several folders.",
}: {
  open: boolean;
  onClose: () => void;
  initial: FolderQueueRef[];
  onSave: (q: FolderQueueRef[]) => void;
  saving: boolean;
  title?: string;
  description?: string;
}) {
  const { byConnection, isLoading } = useAllQueues();
  const [filter, setFilter] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const key = (r: FolderQueueRef) => `${r.connectionId} ${r.queueName}`;

  useEffect(() => {
    if (open) setSelected(new Set(initial.map(key)));
  }, [open, initial]);

  const toggle = (r: FolderQueueRef) =>
    setSelected((s) => {
      const n = new Set(s);
      const k = key(r);
      if (n.has(k)) n.delete(k);
      else n.add(k);
      return n;
    });

  const f = filter.trim().toLowerCase();

  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="md"
      title={title}
      description={description}
      footer={
        <>
          <span className="mr-auto text-xs text-fg-muted">{selected.size} selected</span>
          <Button variant="ghost" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            size="sm"
            loading={saving}
            onClick={() =>
              onSave(
                [...selected].map((k) => {
                  const [connectionId, queueName] = k.split(" ");
                  return { connectionId, queueName };
                }),
              )
            }
          >
            Save
          </Button>
        </>
      }
    >
      <Input leftIcon={<Search />} placeholder="Filter queues…" value={filter} onChange={(e) => setFilter(e.target.value)} autoFocus aria-label="Filter queues" />
      <div className="mt-3 max-h-[50vh] space-y-3 overflow-y-auto">
        {isLoading && <PageSpinner />}
        {byConnection.map(({ connection, queues }) => {
          const visible = queues.filter((q) => !f || q.name.toLowerCase().includes(f)).sort((a, b) => a.name.localeCompare(b.name));
          if (visible.length === 0) return null;
          return (
            <div key={connection.id}>
              <div className="mb-1 flex items-center justify-between text-[11px] font-semibold tracking-wider text-fg-subtle uppercase">
                {connection.name}
                <button
                  type="button"
                  className="font-normal tracking-normal normal-case hover:text-fg"
                  onClick={() =>
                    setSelected((s) => {
                      const n = new Set(s);
                      const all = visible.every((q) => n.has(key({ connectionId: connection.id, queueName: q.name })));
                      visible.forEach((q) => (all ? n.delete(key({ connectionId: connection.id, queueName: q.name })) : n.add(key({ connectionId: connection.id, queueName: q.name }))));
                      return n;
                    })
                  }
                >
                  toggle all
                </button>
              </div>
              <div className="grid gap-1 sm:grid-cols-2">
                {visible.map((q) => {
                  const ref = { connectionId: connection.id, queueName: q.name };
                  return <Checkbox key={q.name} label={q.name} checked={selected.has(key(ref))} onChange={() => toggle(ref)} className="rounded px-1.5 py-1 hover:bg-surface-2" />;
                })}
              </div>
            </div>
          );
        })}
      </div>
    </Dialog>
  );
}
