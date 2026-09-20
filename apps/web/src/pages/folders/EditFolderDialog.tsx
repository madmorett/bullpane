import { useState } from "react";
import type { Folder } from "@bullpane/shared";
import { updateFolderSchema } from "@bullpane/shared";
import { cn } from "@/lib/cn";
import { useUpdateFolder } from "@/api/hooks";
import { errorMessage } from "@/api/client";
import { toast } from "@/components/Toast";
import { Dialog } from "@/components/ui/Dialog";
import { Button } from "@/components/ui/Button";
import { Input, Select } from "@/components/ui/Input";
import { FOLDER_COLORS } from "@/pages/FoldersPage";

export function EditFolderDialog({
  open,
  onClose,
  folder,
  allFolders,
}: {
  open: boolean;
  onClose: () => void;
  folder: Folder;
  allFolders: Folder[];
}) {
  const update = useUpdateFolder();
  const [name, setName] = useState(folder.name);
  const [color, setColor] = useState<string | null>(folder.color);
  const [parentId, setParentId] = useState(folder.parentId ?? "");
  const [error, setError] = useState<string | null>(null);

  // folders nest one level: a folder with children cannot itself become a child
  const hasChildren = allFolders.some((f) => f.parentId === folder.id);
  const parents = allFolders.filter((f) => !f.parentId && f.id !== folder.id);

  const submit = () => {
    const parsed = updateFolderSchema.safeParse({ name: name.trim(), color, parentId: parentId || null });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? "Invalid");
      return;
    }
    update.mutate(
      { id: folder.id, input: parsed.data },
      {
        onSuccess: () => {
          toast.success("Folder updated");
          onClose();
        },
        onError: (e) => toast.error(errorMessage(e)),
      },
    );
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="sm"
      title="Edit folder"
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" size="sm" onClick={submit} loading={update.isPending}>
            Save changes
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
          <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Folder colour">
            {FOLDER_COLORS.map((c) => (
              <button
                key={c}
                type="button"
                role="radio"
                aria-checked={color === c}
                aria-label={c}
                className={cn("size-5 rounded-full ring-offset-2 ring-offset-surface transition-shadow", color === c && "ring-2 ring-fg")}
                style={{ background: c }}
                onClick={() => setColor(c)}
              />
            ))}
            <button
              type="button"
              role="radio"
              aria-checked={!color}
              aria-label="No colour"
              className={cn("size-5 rounded-full border border-dashed border-border-strong ring-offset-2 ring-offset-surface", !color && "ring-2 ring-fg")}
              onClick={() => setColor(null)}
            />
          </div>
        </div>
        <Select
          label="Parent folder"
          value={parentId}
          disabled={hasChildren}
          onChange={(e) => setParentId(e.target.value)}
          options={[{ value: "", label: "None (top level)" }, ...parents.map((f) => ({ value: f.id, label: f.name }))]}
          hint={hasChildren ? "This folder has subfolders, so it must stay top-level." : "Folders nest one level deep."}
        />
      </form>
    </Dialog>
  );
}
