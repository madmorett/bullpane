import { useState } from "react";
import { Pause } from "lucide-react";
import { Dialog } from "@/components/ui/Dialog";
import { Button } from "@/components/ui/Button";
import { Textarea } from "@/components/ui/Input";

export interface PauseQueueDialogProps {
  /** queue about to be paused; null keeps the dialog closed */
  queue: string | null;
  onClose: () => void;
  onConfirm: (reason: string | undefined) => unknown;
  loading?: boolean;
}

/**
 * Pause asks for a reason. Not because pausing is dangerous (Resume undoes it
 * in one click) but because it is the action people ask about afterwards:
 * "who paused billing at 3am, and why?". The reason goes into the audit row,
 * where that question is answered; it is optional so an operator mid-incident
 * is never blocked by a form.
 */
export function PauseQueueDialog({ queue, onClose, onConfirm, loading }: PauseQueueDialogProps) {
  const [reason, setReason] = useState("");
  const submit = () => {
    const trimmed = reason.trim();
    void onConfirm(trimmed ? trimmed : undefined);
  };
  return (
    <Dialog
      open={queue !== null}
      onClose={onClose}
      size="sm"
      title={
        <span className="flex items-center gap-2">
          <Pause className="size-4 text-warning" aria-hidden />
          Pause {queue}
        </span>
      }
      description="Workers stop taking new jobs from this queue; jobs already running finish. Jobs keep arriving and wait until you resume."
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={onClose} disabled={loading}>
            Cancel
          </Button>
          <Button variant="primary" size="sm" loading={loading} onClick={submit}>
            Pause queue
          </Button>
        </>
      }
    >
      <Textarea
        autoFocus
        label="Reason (optional)"
        hint="Recorded in the audit log next to who paused it and when."
        placeholder="e.g. payment provider degraded, holding refunds until they recover"
        rows={3}
        maxLength={500}
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && !loading) submit();
        }}
      />
    </Dialog>
  );
}
