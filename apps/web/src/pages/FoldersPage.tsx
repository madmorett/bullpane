import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { ArrowUpRight, Check, Folder as FolderIcon, FolderPlus, Pencil, Plus, Trash2, X } from "lucide-react";
import { createFolderSchema, type Folder, type FolderQueueRef } from "@bullpane/shared";
import { cn } from "@/lib/cn";
import { routes } from "@/lib/routes";
import { useAllQueues, useCreateFolder, useDeleteFolder, useFolders, useSetFolderQueues, useUpdateFolder } from "@/api/hooks";
import { errorMessage } from "@/api/client";
import { useAuth } from "@/auth/AuthProvider";
import { useEdition } from "@/edition/useEdition";
import { LockedFeature } from "@/edition/LockedFeature";
import { toast } from "@/components/Toast";
import { Page, PageHeader } from "@/components/layout/AppShell";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { Input, Select } from "@/components/ui/Input";
import { EmptyState } from "@/components/ui/EmptyState";
import { PageSpinner } from "@/components/ui/Spinner";
import { Badge } from "@/components/ui/Badge";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { QueuePickerDialog } from "./folders/QueuePickerDialog";

export const FOLDER_COLORS = ["#5b8def", "#3fb950", "#d29922", "#f85149", "#a371f7", "#39c5bb", "#f778ba", "#9aa3ad"];

export function FoldersPage() {
  const { has } = useEdition();
  if (!has("folders")) return <LockedFeature feature="folders" />;
  return <FoldersManager />;
}

function FoldersManager() {
  const { isOperator } = useAuth();
  const folders = useFolders();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [creating, setCreating] = useState<{ parentId: string | null } | null>(null);

  const list = folders.data ?? [];
  const roots = useMemo(() => list.filter((f) => !f.parentId).sort((a, b) => a.position - b.position || a.name.localeCompare(b.name)), [list]);
  const childrenOf = (id: string) => list.filter((f) => f.parentId === id).sort((a, b) => a.position - b.position || a.name.localeCompare(b.name));
  const selected = list.find((f) => f.id === selectedId) ?? null;

  useEffect(() => {
    if (!selectedId && roots[0]) setSelectedId(roots[0].id);
  }, [roots, selectedId]);

  if (folders.isLoading) {
    return (
      <Page>
        <PageSpinner />
      </Page>
    );
  }

  return (
    <Page>
      <PageHeader
        title="Folders"
        description="Group queues from any connection into folders. Nested one level. The sidebar mirrors this tree."
        actions={
          isOperator && (
            <Button variant="primary" size="sm" leftIcon={<FolderPlus />} onClick={() => setCreating({ parentId: null })}>
              New folder
            </Button>
          )
        }
      />
      {list.length === 0 ? (
        <EmptyState
          icon={<FolderIcon />}
          title="No folders yet"
          description="Without folders the sidebar shows one implicit folder per connection. Create a folder to organise queues by team, product or environment."
          action={
            isOperator && (
              <Button variant="primary" leftIcon={<FolderPlus />} onClick={() => setCreating({ parentId: null })}>
                Create the first folder
              </Button>
            )
          }
        />
      ) : (
        <div className="grid gap-4 lg:grid-cols-[280px_1fr]">
          <div className="card p-1.5">
            {roots.map((f) => (
              <div key={f.id}>
                <FolderRow folder={f} selected={selectedId === f.id} onSelect={() => setSelectedId(f.id)} onAddChild={isOperator ? () => setCreating({ parentId: f.id }) : undefined} />
                {childrenOf(f.id).map((c) => (
                  <FolderRow key={c.id} folder={c} depth={1} selected={selectedId === c.id} onSelect={() => setSelectedId(c.id)} />
                ))}
              </div>
            ))}
          </div>
          <div>{selected ? <FolderDetail key={selected.id} folder={selected} allFolders={list} canEdit={isOperator} onDeleted={() => setSelectedId(null)} /> : <EmptyState compact title="Select a folder" />}</div>
        </div>
      )}
      <CreateFolderDialog open={!!creating} parentId={creating?.parentId ?? null} roots={roots} onClose={() => setCreating(null)} onCreated={(f) => setSelectedId(f.id)} />
    </Page>
  );
}

function FolderRow({ folder, depth = 0, selected, onSelect, onAddChild }: { folder: Folder; depth?: number; selected: boolean; onSelect: () => void; onAddChild?: () => void }) {
  return (
    <div className={cn("group flex h-8 items-center gap-2 rounded-md pr-1 text-[13px]", selected ? "bg-surface-3 text-fg" : "text-fg-muted hover:bg-surface-2 hover:text-fg")} style={{ paddingLeft: 8 + depth * 16 }}>
      <button type="button" onClick={onSelect} className="flex min-w-0 flex-1 items-center gap-2 text-left" aria-current={selected || undefined}>
        <FolderIcon className="size-4 shrink-0" style={{ color: folder.color ?? "var(--fg-subtle)" }} aria-hidden />
        <span className="truncate">{folder.name}</span>
        <span className="num ml-auto text-[10px] text-fg-subtle">{folder.queues.length}</span>
      </button>
      {onAddChild && (
        <Button size="icon-xs" variant="ghost" className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100" title="Add subfolder" aria-label="Add subfolder" onClick={onAddChild}>
          <Plus />
        </Button>
      )}
    </div>
  );
}

function FolderDetail({ folder, allFolders, canEdit, onDeleted }: { folder: Folder; allFolders: Folder[]; canEdit: boolean; onDeleted: () => void }) {
  const update = useUpdateFolder();
  const del = useDeleteFolder();
  const setQueues = useSetFolderQueues();
  const { byConnection } = useAllQueues();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(folder.name);
  const [picker, setPicker] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const children = allFolders.filter((f) => f.parentId === folder.id);

  const saveName = () => {
    const n = name.trim();
    if (!n || n === folder.name) {
      setEditing(false);
      setName(folder.name);
      return;
    }
    update.mutate({ id: folder.id, input: { name: n } }, { onSuccess: () => setEditing(false), onError: (e) => toast.error(errorMessage(e)) });
  };

  const removeQueue = (ref: FolderQueueRef) =>
    setQueues.mutate(
      { id: folder.id, input: { queues: folder.queues.filter((q) => !(q.connectionId === ref.connectionId && q.queueName === ref.queueName)) } },
      { onError: (e) => toast.error(errorMessage(e)) },
    );

  const connName = (id: string) => byConnection.find((b) => b.connection.id === id)?.connection.name ?? id;

  return (
    <div className="space-y-4">
      <div className="card p-4">
        <div className="flex flex-wrap items-start gap-3">
          <FolderIcon className="mt-1 size-6" style={{ color: folder.color ?? "var(--fg-subtle)" }} aria-hidden />
          <div className="min-w-0 flex-1">
            {editing ? (
              <form
                className="flex items-center gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  saveName();
                }}
              >
                <Input autoFocus value={name} onChange={(e) => setName(e.target.value)} className="!h-8 max-w-xs" aria-label="Folder name" onKeyDown={(e) => e.key === "Escape" && (setEditing(false), setName(folder.name))} />
                <Button size="icon-sm" type="submit" variant="primary" aria-label="Save" loading={update.isPending}>
                  <Check />
                </Button>
                <Button size="icon-sm" variant="ghost" aria-label="Cancel" onClick={() => (setEditing(false), setName(folder.name))}>
                  <X />
                </Button>
              </form>
            ) : (
              <h2 className="flex items-center gap-2 text-base font-semibold">
                {folder.name}
                {canEdit && (
                  <Button size="icon-xs" variant="ghost" aria-label="Rename" onClick={() => setEditing(true)}>
                    <Pencil />
                  </Button>
                )}
              </h2>
            )}
            <p className="text-xs text-fg-muted">
              {folder.parentId ? `Subfolder of ${allFolders.find((f) => f.id === folder.parentId)?.name ?? "?"}` : "Top-level folder"} · {folder.queues.length} queues
              {children.length > 0 && ` · ${children.length} subfolders`}
            </p>
          </div>
          <Link
            to={routes.folder(folder.id)}
            className="inline-flex h-7 items-center gap-1.5 rounded-md border border-border px-2.5 text-xs font-medium text-fg hover:bg-surface-2"
            title="Open this folder's dashboard"
          >
            Open folder
            <ArrowUpRight className="size-3.5" aria-hidden />
          </Link>
          {canEdit && (
            <Button size="sm" variant="ghost" className="hover:text-danger" leftIcon={<Trash2 />} onClick={() => setConfirmDelete(true)}>
              Delete
            </Button>
          )}
        </div>

        {canEdit && (
          <div className="mt-4 flex flex-wrap items-center gap-4">
            <div>
              <span className="mb-1 block text-[10px] tracking-wide text-fg-subtle uppercase">Colour</span>
              <div className="flex gap-1.5" role="radiogroup" aria-label="Folder colour">
                {FOLDER_COLORS.map((c) => (
                  <button
                    key={c}
                    type="button"
                    role="radio"
                    aria-checked={folder.color === c}
                    aria-label={c}
                    className={cn("size-5 rounded-full ring-offset-2 ring-offset-surface transition-shadow", folder.color === c && "ring-2 ring-fg")}
                    style={{ background: c }}
                    onClick={() => update.mutate({ id: folder.id, input: { color: c } }, { onError: (e) => toast.error(errorMessage(e)) })}
                  />
                ))}
                <button
                  type="button"
                  role="radio"
                  aria-checked={!folder.color}
                  aria-label="No colour"
                  className={cn("size-5 rounded-full border border-dashed border-border-strong ring-offset-2 ring-offset-surface", !folder.color && "ring-2 ring-fg")}
                  onClick={() => update.mutate({ id: folder.id, input: { color: null } }, { onError: (e) => toast.error(errorMessage(e)) })}
                />
              </div>
            </div>
            {!children.length && (
              <Select
                label="Parent"
                className="!h-8 w-56"
                value={folder.parentId ?? ""}
                onChange={(e) => update.mutate({ id: folder.id, input: { parentId: e.target.value || null } }, { onError: (err) => toast.error(errorMessage(err)) })}
                options={[{ value: "", label: "None (top level)" }, ...allFolders.filter((f) => !f.parentId && f.id !== folder.id).map((f) => ({ value: f.id, label: f.name }))]}
              />
            )}
          </div>
        )}
      </div>

      <div className="card">
        <div className="flex items-center justify-between border-b border-border px-4 py-2.5">
          <h3 className="text-xs font-semibold tracking-wider text-fg-subtle uppercase">Queues</h3>
          {canEdit && (
            <Button size="sm" leftIcon={<Plus />} onClick={() => setPicker(true)}>
              Assign queues
            </Button>
          )}
        </div>
        {folder.queues.length === 0 ? (
          <p className="px-4 py-8 text-center text-xs text-fg-subtle">No queues assigned yet.</p>
        ) : (
          <ul className="divide-y divide-border">
            {folder.queues.map((ref) => (
              <li key={`${ref.connectionId}/${ref.queueName}`} className="flex items-center gap-3 px-4 py-2 text-[13px]">
                <Link to={routes.queue(ref.connectionId, ref.queueName)} className="font-medium hover:underline">
                  {ref.queueName}
                </Link>
                <Badge variant="outline" size="xs">
                  {connName(ref.connectionId)}
                </Badge>
                {canEdit && (
                  <Button size="icon-xs" variant="ghost" className="ml-auto hover:text-danger" aria-label="Remove from folder" onClick={() => removeQueue(ref)}>
                    <X />
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      <QueuePickerDialog
        open={picker}
        onClose={() => setPicker(false)}
        initial={folder.queues}
        onSave={(queues) => setQueues.mutate({ id: folder.id, input: { queues } }, { onSuccess: () => (setPicker(false), toast.success("Folder updated")), onError: (e) => toast.error(errorMessage(e)) })}
        saving={setQueues.isPending}
      />
      <ConfirmDialog
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        title={`Delete "${folder.name}"`}
        description={children.length > 0 ? "Subfolders are deleted too. Queues themselves are untouched." : "Queues themselves are untouched."}
        confirmText="Delete folder"
        danger
        loading={del.isPending}
        onConfirm={() => del.mutate(folder.id, { onSuccess: () => (setConfirmDelete(false), onDeleted(), toast.success("Folder deleted")), onError: (e) => toast.error(errorMessage(e)) })}
      />
    </div>
  );
}

function CreateFolderDialog({ open, parentId, roots, onClose, onCreated }: { open: boolean; parentId: string | null; roots: Folder[]; onClose: () => void; onCreated: (f: Folder) => void }) {
  const create = useCreateFolder();
  const [name, setName] = useState("");
  const [color, setColor] = useState<string | null>(FOLDER_COLORS[0]);
  const [parent, setParent] = useState<string>(parentId ?? "");
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setParent(parentId ?? ""), [parentId, open]);

  const submit = () => {
    const parsed = createFolderSchema.safeParse({ name: name.trim(), color, parentId: parent || null });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? "Invalid");
      return;
    }
    create.mutate(parsed.data, {
      onSuccess: (f) => {
        toast.success(`Folder "${f.name}" created`);
        onCreated(f);
        onClose();
      },
      onError: (e) => toast.error(errorMessage(e)),
    });
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="sm"
      title="New folder"
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" size="sm" onClick={submit} loading={create.isPending}>
            Create
          </Button>
        </>
      }
    >
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <Input label="Name" autoFocus value={name} onChange={(e) => setName(e.target.value)} error={error} />
        <div>
          <span className="mb-1 block text-xs font-medium text-fg-muted">Colour</span>
          <div className="flex gap-1.5" role="radiogroup" aria-label="Folder colour">
            {FOLDER_COLORS.map((c) => (
              <button key={c} type="button" role="radio" aria-checked={color === c} aria-label={c} className={cn("size-5 rounded-full ring-offset-2 ring-offset-surface", color === c && "ring-2 ring-fg")} style={{ background: c }} onClick={() => setColor(c)} />
            ))}
          </div>
        </div>
        <Select label="Parent folder" value={parent} onChange={(e) => setParent(e.target.value)} options={[{ value: "", label: "None (top level)" }, ...roots.map((f) => ({ value: f.id, label: f.name }))]} hint="Folders nest one level deep." />
      </form>
    </Dialog>
  );
}
