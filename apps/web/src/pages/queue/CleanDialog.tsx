import { useState } from "react";
import { cleanQueueSchema, type CleanQueueInput } from "@bullpane/shared";
import { useQueueAction } from "@/api/hooks";
import { errorMessage } from "@/api/client";
import { formatNumber } from "@/lib/format";
import { toast } from "@/components/Toast";
import { Dialog } from "@/components/ui/Dialog";
import { Button } from "@/components/ui/Button";
import { Input, Select } from "@/components/ui/Input";

const STATES = cleanQueueSchema.shape.state.options;
const GRACE_PRESETS = [
  { label: "Any age", value: 0 },
  { label: "Older than 1 hour", value: 3_600_000 },
  { label: "Older than 1 day", value: 86_400_000 },
  { label: "Older than 7 days", value: 7 * 86_400_000 },
];

export function CleanDialog({ open, onClose, connectionId, queue, defaultState }: { open: boolean; onClose: () => void; connectionId: string; queue: string; defaultState?: CleanQueueInput["state"] }) {
  const action = useQueueAction(connectionId, queue);
  const [state, setState] = useState<CleanQueueInput["state"]>(defaultState ?? "completed");
  const [grace, setGrace] = useState<number>(0);
  const [limit, setLimit] = useState<string>("1000");
  const [error, setError] = useState<string | null>(null);

  const submit = () => {
    const parsed = cleanQueueSchema.safeParse({ state, grace, limit: Number(limit) });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? "Invalid input");
      return;
    }
    setError(null);
    action.mutate(
      { action: "clean", body: parsed.data },
      {
        onSuccess: (r) => {
          toast.success(`Cleaned ${formatNumber(r.removed ?? 0)} ${state} jobs from ${queue}`);
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
      title={`Clean ${queue}`}
      description="Removes jobs in a state, oldest first, up to the limit. Uses BullMQ's queue.clean()."
      size="sm"
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="danger" size="sm" onClick={submit} loading={action.isPending}>
            Clean jobs
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <Select label="State" value={state} onChange={(e) => setState(e.target.value as CleanQueueInput["state"])} options={STATES.map((s) => ({ value: s, label: s }))} />
        <Select label="Grace period" value={String(grace)} onChange={(e) => setGrace(Number(e.target.value))} options={GRACE_PRESETS.map((g) => ({ value: String(g.value), label: g.label }))} hint="Only jobs older than this are removed." />
        <Input label="Limit" type="number" min={1} max={100000} value={limit} onChange={(e) => setLimit(e.target.value)} error={error ?? undefined} hint="Maximum number of jobs to remove in this run (1–100,000)." />
      </div>
    </Dialog>
  );
}
