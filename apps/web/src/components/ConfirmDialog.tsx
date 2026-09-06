import { useState, type ReactNode } from "react";
import { AlertTriangle } from "lucide-react";
import { Dialog } from "@/components/ui/Dialog";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";

export interface ConfirmDialogProps {
  open: boolean;
  onClose: () => void;
  onConfirm: () => unknown;
  title: ReactNode;
  description?: ReactNode;
  confirmText?: string;
  danger?: boolean;
  /** when set, the user must type this exact string to enable the confirm button */
  typeToConfirm?: string;
  loading?: boolean;
  children?: ReactNode;
}

export function ConfirmDialog({
  open,
  onClose,
  onConfirm,
  title,
  description,
  confirmText = "Confirm",
  danger,
  typeToConfirm,
  loading,
  children,
}: ConfirmDialogProps) {
  const [typed, setTyped] = useState("");
  const ready = !typeToConfirm || typed === typeToConfirm;

  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="sm"
      title={
        <span className="flex items-center gap-2">
          {danger && <AlertTriangle className="size-4 text-danger" aria-hidden />}
          {title}
        </span>
      }
      description={description}
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={onClose} disabled={loading}>
            Cancel
          </Button>
          <Button
            variant={danger ? "danger" : "primary"}
            size="sm"
            disabled={!ready}
            loading={loading}
            onClick={async () => {
              await onConfirm();
              setTyped("");
            }}
          >
            {confirmText}
          </Button>
        </>
      }
    >
      {children}
      {typeToConfirm && (
        <Input
          autoFocus
          mono
          label={
            <>
              Type <span className="font-mono text-fg">{typeToConfirm}</span> to confirm
            </>
          }
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && ready && !loading) void onConfirm();
          }}
          autoComplete="off"
          spellCheck={false}
        />
      )}
    </Dialog>
  );
}
