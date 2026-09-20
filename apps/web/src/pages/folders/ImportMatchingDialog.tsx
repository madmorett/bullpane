import { useMemo, useState } from "react";
import { Info, Wand2 } from "lucide-react";
import type { FolderQueueRef } from "@bullpane/shared";
import { formatNumber } from "@/lib/format";
import { globMatches } from "@/lib/glob";
import { useAllQueues } from "@/api/hooks";
import { Dialog } from "@/components/ui/Dialog";
import { Button } from "@/components/ui/Button";
import { Input, Select } from "@/components/ui/Input";
import { Badge } from "@/components/ui/Badge";

const ANY = "__any__";

/**
 * One-shot import by prefix / suffix.
 *
 * The server stores no rules — there is no endpoint for a saved pattern — so
 * this resolves the glob against the queues already loaded in the browser and
 * writes the union through PUT /folders/:id/queues. It is an import, not a
 * subscription, and the copy says so in as many words.
 */
export function ImportMatchingDialog({
  open,
  onClose,
  existing,
  onImport,
  saving,
}: {
  open: boolean;
  onClose: () => void;
  existing: FolderQueueRef[];
  onImport: (queues: FolderQueueRef[]) => void;
  saving: boolean;
}) {
  const { byConnection } = useAllQueues();
  const [pattern, setPattern] = useState("");
  const [connectionId, setConnectionId] = useState<string>(ANY);

  const have = useMemo(() => new Set(existing.map((r) => `${r.connectionId} ${r.queueName}`)), [existing]);

  const matches = useMemo(() => {
    const p = pattern.trim();
    if (!p) return [];
    const out: { ref: FolderQueueRef; connectionName: string; already: boolean }[] = [];
    for (const { connection, queues } of byConnection) {
      if (connectionId !== ANY && connection.id !== connectionId) continue;
      for (const q of queues) {
        if (!globMatches(p, q.name)) continue;
        const ref = { connectionId: connection.id, queueName: q.name };
        out.push({ ref, connectionName: connection.name, already: have.has(`${connection.id} ${q.name}`) });
      }
    }
    return out.sort((a, b) => a.ref.queueName.localeCompare(b.ref.queueName));
  }, [pattern, connectionId, byConnection, have]);

  const toAdd = matches.filter((m) => !m.already);

  const submit = () => {
    // union: never drop what is already in the folder
    onImport([...existing, ...toAdd.map((m) => m.ref)]);
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="md"
      title="Import matching queues"
      description="Add every queue whose name matches a pattern, in one go."
      footer={
        <>
          <span className="mr-auto text-xs text-fg-muted">
            {pattern.trim() === "" ? "Type a pattern to preview" : `${formatNumber(toAdd.length)} to add · ${formatNumber(matches.length - toAdd.length)} already in folder`}
          </span>
          <Button variant="ghost" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" size="sm" leftIcon={<Wand2 />} loading={saving} disabled={toAdd.length === 0} onClick={submit}>
            Import {toAdd.length > 0 ? formatNumber(toAdd.length) : ""}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-[1fr_200px]">
          <Input
            label="Pattern"
            mono
            autoFocus
            placeholder="channels*"
            value={pattern}
            onChange={(e) => setPattern(e.target.value)}
            hint="* matches any run of characters, ? matches exactly one. Case-insensitive."
          />
          <Select
            label="Connection"
            value={connectionId}
            onChange={(e) => setConnectionId(e.target.value)}
            options={[{ value: ANY, label: "Any connection" }, ...byConnection.map((b) => ({ value: b.connection.id, label: b.connection.name }))]}
          />
        </div>

        <div className="flex flex-wrap gap-1.5 text-[11px] text-fg-subtle">
          <span>Examples:</span>
          {["channels*", "*-retry", "email-?"].map((ex) => (
            <button key={ex} type="button" onClick={() => setPattern(ex)} className="rounded border border-border bg-surface-2 px-1.5 py-0.5 font-mono text-fg-muted hover:text-fg">
              {ex}
            </button>
          ))}
        </div>

        <div className="rounded-md border border-border">
          <div className="flex items-center justify-between border-b border-border bg-surface-2/50 px-3 py-1.5 text-[11px] font-semibold tracking-wider text-fg-subtle uppercase">
            Preview
            <span className="num font-normal tracking-normal normal-case">{formatNumber(matches.length)} matching</span>
          </div>
          <div className="max-h-64 overflow-y-auto">
            {pattern.trim() === "" ? (
              <p className="px-3 py-6 text-center text-xs text-fg-subtle">Nothing to preview yet.</p>
            ) : matches.length === 0 ? (
              <p className="px-3 py-6 text-center text-xs text-fg-subtle">
                No queue matches <span className="font-mono text-fg-muted">{pattern.trim()}</span>
                {connectionId !== ANY && " on this connection"}.
              </p>
            ) : (
              <ul className="divide-y divide-border">
                {matches.map((m) => (
                  <li key={`${m.ref.connectionId}/${m.ref.queueName}`} className="flex items-center gap-2 px-3 py-1.5 text-xs">
                    <span className="truncate font-mono text-fg">{m.ref.queueName}</span>
                    <Badge variant="outline" size="xs">
                      {m.connectionName}
                    </Badge>
                    {m.already && <span className="ml-auto shrink-0 text-[10px] text-fg-subtle">already in folder</span>}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>

        <p className="flex items-start gap-2 rounded-md border border-border bg-surface-2/50 px-3 py-2 text-[11px] leading-relaxed text-fg-muted">
          <Info className="mt-0.5 size-3.5 shrink-0 text-fg-subtle" aria-hidden />
          <span>
            Imports the queues matching this pattern <strong className="text-fg">now</strong>. New queues that appear later are{" "}
            <strong className="text-fg">not</strong> added automatically — run the import again when they show up.
          </span>
        </p>
      </div>
    </Dialog>
  );
}
