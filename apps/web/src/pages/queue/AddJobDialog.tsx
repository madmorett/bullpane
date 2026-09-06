import { useState } from "react";
import { addJobSchema } from "@bullmq-visualizer/shared";
import { useAddJob } from "@/api/hooks";
import { errorMessage } from "@/api/client";
import { toast } from "@/components/Toast";
import { Dialog } from "@/components/ui/Dialog";
import { Button } from "@/components/ui/Button";
import { Input, Textarea } from "@/components/ui/Input";

function parseJson(text: string, label: string): { value?: unknown; error?: string } {
  const t = text.trim();
  if (!t) return { value: {} };
  try {
    return { value: JSON.parse(t) };
  } catch (e) {
    return { error: `${label}: ${(e as Error).message}` };
  }
}

export function AddJobDialog({ open, onClose, connectionId, queue }: { open: boolean; onClose: () => void; connectionId: string; queue: string }) {
  const add = useAddJob(connectionId, queue);
  const [name, setName] = useState("");
  const [data, setData] = useState("{\n  \n}");
  const [opts, setOpts] = useState("{}");
  const [errors, setErrors] = useState<{ name?: string; data?: string; opts?: string }>({});

  const submit = () => {
    const d = parseJson(data, "Data");
    const o = parseJson(opts, "Options");
    const next: typeof errors = {};
    if (d.error) next.data = d.error;
    if (o.error) next.opts = o.error;
    if (!o.error && (typeof o.value !== "object" || o.value === null || Array.isArray(o.value))) next.opts = "Options must be a JSON object";
    setErrors(next);
    if (Object.keys(next).length) return;
    const parsed = addJobSchema.safeParse({ name: name.trim() || undefined, data: d.value, opts: o.value });
    if (!parsed.success) {
      setErrors({ name: parsed.error.issues[0]?.message });
      return;
    }
    add.mutate(parsed.data, {
      onSuccess: (r) => {
        toast.success(`Job ${r.id} added to ${queue}`);
        onClose();
      },
      onError: (e) => toast.error(errorMessage(e)),
    });
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={`Add job to ${queue}`}
      description="The job is added with the official BullMQ client; opts follow JobsOptions (delay, priority, attempts, backoff, …)."
      size="lg"
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" size="sm" onClick={submit} loading={add.isPending}>
            Add job
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <Input label="Name" placeholder="__default__" value={name} onChange={(e) => setName(e.target.value)} error={errors.name} mono autoFocus />
        <Textarea label="Data (JSON)" mono rows={8} value={data} onChange={(e) => setData(e.target.value)} error={errors.data} spellCheck={false} />
        <Textarea
          label="Options (JSON)"
          mono
          rows={4}
          value={opts}
          onChange={(e) => setOpts(e.target.value)}
          error={errors.opts}
          hint='e.g. {"delay": 5000, "attempts": 3, "backoff": {"type": "exponential", "delay": 1000}}'
          spellCheck={false}
        />
      </div>
    </Dialog>
  );
}
