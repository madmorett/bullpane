import { useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { ALERT_KINDS, createAlertSchema, type Alert, type AlertChannel, type AlertCondition, type AlertKind, type AlertScope, type CreateAlertInput } from "@bullmq-visualizer/shared";
import { useConnections, useCreateAlert, useFolders, useQueues, useUpdateAlert } from "@/api/hooks";
import { errorMessage } from "@/api/client";
import { toast } from "@/components/Toast";
import { Dialog } from "@/components/ui/Dialog";
import { Button } from "@/components/ui/Button";
import { Checkbox, Field, Input, Select, Textarea } from "@/components/ui/Input";

export const KIND_LABEL: Record<AlertKind, string> = {
  waiting_above: "Waiting jobs above threshold",
  failed_above: "Failures above threshold in a window",
  failed_rate_above: "Failure rate above percent",
};

interface ChannelDraft {
  type: AlertChannel["type"];
  url: string;
  headersText: string;
}

interface Draft {
  name: string;
  enabled: boolean;
  scopeType: AlertScope["type"];
  connectionId: string;
  queueName: string;
  folderId: string;
  kind: AlertKind;
  threshold: string;
  windowMinutes: string;
  percent: string;
  minSample: string;
  cooldownMinutes: string;
  channels: ChannelDraft[];
}

function emptyDraft(connectionId: string, scope?: AlertScope): Draft {
  return {
    name: "",
    enabled: true,
    scopeType: scope?.type ?? "queue",
    connectionId: scope?.type === "queue" ? scope.connectionId : connectionId,
    queueName: scope?.type === "queue" ? scope.queueName : "",
    folderId: scope?.type === "folder" ? scope.folderId : "",
    kind: "failed_above",
    threshold: "10",
    windowMinutes: "5",
    percent: "5",
    minSample: "20",
    cooldownMinutes: "30",
    channels: [{ type: "slack", url: "", headersText: "" }],
  };
}

function fromAlert(a: Alert): Draft {
  const c = a.condition;
  return {
    name: a.name,
    enabled: a.enabled,
    scopeType: a.scope.type,
    connectionId: a.scope.type === "queue" ? a.scope.connectionId : "",
    queueName: a.scope.type === "queue" ? a.scope.queueName : "",
    folderId: a.scope.type === "folder" ? a.scope.folderId : "",
    kind: c.kind,
    threshold: "threshold" in c ? String(c.threshold) : "10",
    windowMinutes: "windowMinutes" in c ? String(c.windowMinutes) : "5",
    percent: "percent" in c ? String(c.percent) : "5",
    minSample: "minSample" in c ? String(c.minSample) : "20",
    cooldownMinutes: String(a.cooldownMinutes),
    channels: a.channels.map((ch) =>
      ch.type === "slack"
        ? { type: "slack", url: ch.webhookUrl, headersText: "" }
        : {
            type: "webhook",
            url: ch.url,
            headersText: Object.entries(ch.headers ?? {})
              .map(([k, v]) => `${k}: ${v}`)
              .join("\n"),
          },
    ),
  };
}

function parseHeaders(text: string): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    const idx = t.indexOf(":");
    if (idx <= 0) throw new Error(`Header line "${t}" must look like "Name: value"`);
    out[t.slice(0, idx).trim()] = t.slice(idx + 1).trim();
  }
  return Object.keys(out).length ? out : undefined;
}

function toInput(d: Draft): CreateAlertInput {
  const num = (s: string) => (s.trim() === "" ? NaN : Number(s));
  let condition: AlertCondition;
  switch (d.kind) {
    case "waiting_above":
      condition = { kind: "waiting_above", threshold: num(d.threshold) };
      break;
    case "failed_above":
      condition = { kind: "failed_above", threshold: num(d.threshold), windowMinutes: num(d.windowMinutes) };
      break;
    default:
      condition = { kind: "failed_rate_above", percent: num(d.percent), windowMinutes: num(d.windowMinutes), minSample: num(d.minSample) };
      break;
  }
  const scope: AlertScope = d.scopeType === "folder" ? { type: "folder", folderId: d.folderId } : { type: "queue", connectionId: d.connectionId, queueName: d.queueName };
  const channels: AlertChannel[] = d.channels.map((c) => (c.type === "slack" ? { type: "slack", webhookUrl: c.url.trim() } : { type: "webhook", url: c.url.trim(), headers: parseHeaders(c.headersText) }));
  return {
    name: d.name.trim(),
    enabled: d.enabled,
    scope,
    condition,
    channels,
    cooldownMinutes: num(d.cooldownMinutes),
  };
}

export function AlertDialog({
  open,
  onClose,
  alert,
  initialScope,
}: {
  open: boolean;
  onClose: () => void;
  alert: Alert | null;
  /**
   * Pre-scope a NEW alert (the queue page and the folder page both open this
   * dialog already pointed at what the user was looking at). Ignored when
   * editing an existing alert, whose own scope always wins.
   */
  initialScope?: AlertScope;
}) {
  const connections = useConnections();
  const create = useCreateAlert();
  const update = useUpdateAlert();
  const firstConnection = connections.data?.[0]?.id ?? "";
  const [draft, setDraft] = useState<Draft>(() => (alert ? fromAlert(alert) : emptyDraft(firstConnection, initialScope)));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const queues = useQueues(draft.connectionId || undefined, { enabled: draft.scopeType === "queue" });
  const folders = useFolders();

  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setDraft((d) => ({ ...d, [k]: v }));
  const setChannel = (i: number, patch: Partial<ChannelDraft>) => setDraft((d) => ({ ...d, channels: d.channels.map((c, j) => (j === i ? { ...c, ...patch } : c)) }));

  const busy = create.isPending || update.isPending;

  const submit = () => {
    let input: CreateAlertInput;
    try {
      input = toInput(draft);
    } catch (e) {
      setErrors({ channels: (e as Error).message });
      return;
    }
    const parsed = createAlertSchema.safeParse(input);
    if (!parsed.success) {
      const next: Record<string, string> = {};
      for (const issue of parsed.error.issues) {
        const p = issue.path[0] === "condition" || issue.path[0] === "scope" ? String(issue.path[1] ?? issue.path[0]) : issue.path[0] === "channels" ? "channels" : String(issue.path[0]);
        next[p] = issue.path[0] === "channels" ? `Channel ${Number(issue.path[1]) + 1}: ${issue.message}` : issue.message;
      }
      setErrors(next);
      return;
    }
    setErrors({});
    const done = () => {
      toast.success(alert ? "Alert updated" : "Alert created");
      onClose();
    };
    if (alert) update.mutate({ id: alert.id, input: parsed.data }, { onSuccess: done, onError: (e) => toast.error(errorMessage(e)) });
    else create.mutate(parsed.data, { onSuccess: done, onError: (e) => toast.error(errorMessage(e)) });
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="lg"
      title={alert ? `Edit alert` : "New alert"}
      description="Evaluated on the server against live counts. Notifications go to every channel, then wait for the cooldown."
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" size="sm" onClick={submit} loading={busy}>
            {alert ? "Save changes" : "Create alert"}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-[1fr_auto]">
          <Input label="Name" value={draft.name} onChange={(e) => set("name", e.target.value)} error={errors.name} autoFocus placeholder="payments: failures spiking" />
          <Field label="Enabled" className="justify-end">
            <Checkbox checked={draft.enabled} onChange={(e) => set("enabled", e.target.checked)} label={draft.enabled ? "On" : "Off"} className="h-8 items-center" />
          </Field>
        </div>

        <fieldset className="grid gap-3 rounded-md border border-border p-3 sm:grid-cols-3">
          <legend className="px-1 text-[11px] font-semibold tracking-wider text-fg-subtle uppercase">Scope</legend>
          <Select
            label="Watch"
            value={draft.scopeType}
            onChange={(e) => set("scopeType", e.target.value as AlertScope["type"])}
            options={[
              { value: "queue", label: "One queue" },
              { value: "folder", label: "Every queue in a folder" },
            ]}
            hint={draft.scopeType === "folder" ? "Fires when any queue in the folder breaches; reports the worst one." : undefined}
          />
          {draft.scopeType === "queue" ? (
            <>
              <Select
                label="Connection"
                value={draft.connectionId}
                onChange={(e) => setDraft((d) => ({ ...d, connectionId: e.target.value, queueName: "" }))}
                error={errors.connectionId}
                options={(connections.data ?? []).map((c) => ({ value: c.id, label: c.name }))}
              />
              <Select
                label="Queue"
                value={draft.queueName}
                onChange={(e) => set("queueName", e.target.value)}
                error={errors.queueName}
                options={[{ value: "", label: queues.isLoading ? "Loading…" : "Pick a queue", disabled: true }, ...(queues.data ?? []).map((q) => ({ value: q.name, label: q.name }))]}
              />
            </>
          ) : (
            <Select
              label="Folder"
              value={draft.folderId}
              onChange={(e) => set("folderId", e.target.value)}
              error={errors.folderId}
              wrapperClassName="sm:col-span-2"
              options={[{ value: "", label: folders.isLoading ? "Loading…" : folders.data?.length ? "Pick a folder" : "No folders yet", disabled: true }, ...(folders.data ?? []).map((f) => ({ value: f.id, label: f.parentId ? `${folders.data?.find((p) => p.id === f.parentId)?.name ?? "?"} / ${f.name}` : f.name }))]}
            />
          )}
        </fieldset>

        <fieldset className="grid gap-3 rounded-md border border-border p-3">
          <legend className="px-1 text-[11px] font-semibold tracking-wider text-fg-subtle uppercase">Condition</legend>
          <Select label="Kind" value={draft.kind} onChange={(e) => set("kind", e.target.value as AlertKind)} options={ALERT_KINDS.map((k) => ({ value: k, label: KIND_LABEL[k] }))} />
          <div className="grid gap-3 sm:grid-cols-3">
            {(draft.kind === "waiting_above" || draft.kind === "failed_above") && (
              <Input label={draft.kind === "waiting_above" ? "Waiting jobs above" : "Failures above"} type="number" min={1} value={draft.threshold} onChange={(e) => set("threshold", e.target.value)} error={errors.threshold} />
            )}
            {draft.kind === "failed_rate_above" && <Input label="Failure rate above (%)" type="number" min={0.1} max={100} step={0.1} value={draft.percent} onChange={(e) => set("percent", e.target.value)} error={errors.percent} />}
            {(draft.kind === "failed_above" || draft.kind === "failed_rate_above") && (
              <Input label="Window (minutes)" type="number" min={1} max={1440} value={draft.windowMinutes} onChange={(e) => set("windowMinutes", e.target.value)} error={errors.windowMinutes} />
            )}
            {draft.kind === "failed_rate_above" && (
              <Input label="Min sample (finished jobs)" type="number" min={1} value={draft.minSample} onChange={(e) => set("minSample", e.target.value)} error={errors.minSample} hint="Ignore windows with fewer finished jobs." />
            )}
          </div>
        </fieldset>

        <fieldset className="space-y-3 rounded-md border border-border p-3">
          <legend className="px-1 text-[11px] font-semibold tracking-wider text-fg-subtle uppercase">Channels</legend>
          {draft.channels.map((c, i) => (
            <div key={i} className="grid gap-2 rounded-md bg-surface-2/50 p-2 sm:grid-cols-[130px_1fr_auto]">
              <Select aria-label="Channel type" value={c.type} onChange={(e) => setChannel(i, { type: e.target.value as ChannelDraft["type"] })} options={[{ value: "slack", label: "Slack webhook" }, { value: "webhook", label: "Webhook (POST)" }]} />
              <Input aria-label="URL" mono placeholder={c.type === "slack" ? "https://hooks.slack.com/services/…" : "https://example.com/hooks/bullmq"} value={c.url} onChange={(e) => setChannel(i, { url: e.target.value })} />
              <Button size="icon" variant="ghost" aria-label="Remove channel" className="hover:text-danger" disabled={draft.channels.length === 1} onClick={() => setDraft((d) => ({ ...d, channels: d.channels.filter((_, j) => j !== i) }))}>
                <Trash2 />
              </Button>
              {c.type === "webhook" && (
                <Textarea aria-label="Headers" mono rows={2} placeholder={"Authorization: Bearer …\nX-Source: bullmq-visualizer"} value={c.headersText} onChange={(e) => setChannel(i, { headersText: e.target.value })} wrapperClassName="sm:col-span-3" hint="One header per line, Name: value" />
              )}
            </div>
          ))}
          {errors.channels && (
            <p className="text-xs text-danger" role="alert">
              {errors.channels}
            </p>
          )}
          <Button size="sm" variant="ghost" leftIcon={<Plus />} onClick={() => setDraft((d) => ({ ...d, channels: [...d.channels, { type: "webhook", url: "", headersText: "" }] }))}>
            Add channel
          </Button>
        </fieldset>

        <Input label="Cooldown (minutes)" type="number" min={1} max={1440} value={draft.cooldownMinutes} onChange={(e) => set("cooldownMinutes", e.target.value)} error={errors.cooldownMinutes} hint="Minimum time between notifications while the alert keeps firing." wrapperClassName="max-w-xs" />
      </div>
    </Dialog>
  );
}
