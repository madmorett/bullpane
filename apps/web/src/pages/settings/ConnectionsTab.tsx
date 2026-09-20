import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { CheckCircle2, Database, Pencil, Plug, Plus, Trash2, XCircle } from "lucide-react";
import { createConnectionSchema, type CreateConnectionInput, type RedisConnection } from "@bullpane/shared";
import { routes } from "@/lib/routes";
import { useConnections, useCreateConnection, useDeleteConnection, useTestConnection, useUpdateConnection, type PingResult } from "@/api/hooks";
import { errorMessage } from "@/api/client";
import { useAuth } from "@/auth/AuthProvider";
import { useEdition } from "@/edition/useEdition";
import { toast } from "@/components/Toast";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { Dialog } from "@/components/ui/Dialog";
import { Checkbox, Input, Switch } from "@/components/ui/Input";
import { DEFAULT_REDIS_PARTS, partsChanged, partsFromUrl, urlFromParts, type RedisParts } from "@/lib/redisUrl";
import { Table, TableMessage, Td, Th } from "@/components/ui/Table";
import { EmptyState } from "@/components/ui/EmptyState";
import { Spinner } from "@/components/ui/Spinner";
import { RelativeTime } from "@/components/ui/RelativeTime";
import { ConnectionStatusDot } from "@/components/ConnectionStatusDot";
import { ConfirmDialog } from "@/components/ConfirmDialog";

export function ConnectionsTab() {
  const { isAdmin } = useAuth();
  const { demo } = useEdition();
  const connections = useConnections();
  const del = useDeleteConnection();
  const [sp, setSp] = useSearchParams();
  const [dialog, setDialog] = useState<null | { connection: RedisConnection | null }>(null);
  const [deleting, setDeleting] = useState<RedisConnection | null>(null);

  // deep links: ?new=1, ?edit=<id>
  useEffect(() => {
    if (!isAdmin) return;
    if (sp.get("new")) {
      setDialog({ connection: null });
      setSp({}, { replace: true });
    } else if (sp.get("edit") && connections.data) {
      const c = connections.data.find((x) => x.id === sp.get("edit"));
      if (c) setDialog({ connection: c });
      setSp({}, { replace: true });
    }
  }, [sp, setSp, connections.data, isAdmin]);

  const list = connections.data ?? [];

  return (
    <div>
      <div className="mb-3 flex items-center justify-between">
        <p className="text-xs text-fg-muted">
          Each connection points at one Redis (or cluster) with a BullMQ key prefix. Queues are discovered with <span className="font-mono">SCAN</span>, never <span className="font-mono">KEYS</span>.
        </p>
        {isAdmin && (
          <Button variant="primary" size="sm" leftIcon={<Plus />} onClick={() => setDialog({ connection: null })} disabled={demo} title={demo ? "Locked in the demo" : undefined}>
            Add connection
          </Button>
        )}
      </div>
      {demo && <p className="mb-3 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-warning">Demo mode: connections are read-only.</p>}

      <div className="card overflow-hidden">
        <Table>
          <thead>
            <tr>
              <Th>Name</Th>
              <Th>URL</Th>
              <Th>Prefix</Th>
              <Th>Filter</Th>
              <Th>Status</Th>
              <Th>Added</Th>
              <Th align="right">
                <span className="sr-only">Actions</span>
              </Th>
            </tr>
          </thead>
          <tbody>
            {connections.isLoading && (
              <TableMessage colSpan={7}>
                <Spinner />
              </TableMessage>
            )}
            {connections.data && list.length === 0 && (
              <tr>
                <td colSpan={7}>
                  <EmptyState compact icon={<Database />} title="No connections" description={isAdmin ? "Add your first Redis connection." : "Ask an admin to add one."} />
                </td>
              </tr>
            )}
            {list.map((c) => (
              <tr key={c.id}>
                <Td className="font-medium">
                  <Link to={routes.connection(c.id)} className="hover:underline">
                    {c.name}
                  </Link>
                  {c.cluster && (
                    <Badge variant="outline" size="xs" className="ml-1.5">
                      cluster
                    </Badge>
                  )}
                </Td>
                <Td mono muted className="max-w-xs truncate" title={c.url}>
                  {c.url}
                </Td>
                <Td mono>{c.prefix}</Td>
                <Td mono muted>
                  {c.queueFilter ?? "–"}
                </Td>
                <Td>
                  <span className="flex items-center gap-2">
                    <ConnectionStatusDot status={c.status} withLabel pulse />
                    {c.status?.ok && c.status.redisVersion && <span className="text-[11px] text-fg-subtle">v{c.status.redisVersion}</span>}
                  </span>
                  {c.status && !c.status.ok && c.status.error && <p className="mt-0.5 max-w-xs truncate text-[11px] text-danger" title={c.status.error}>{c.status.error}</p>}
                </Td>
                <Td muted>
                  <RelativeTime value={c.createdAt} />
                </Td>
                <Td align="right">
                  {isAdmin && (
                    <div className="flex items-center justify-end gap-1">
                      <Button size="icon-xs" variant="ghost" aria-label="Edit connection" title="Edit" onClick={() => setDialog({ connection: c })} disabled={demo}>
                        <Pencil />
                      </Button>
                      <Button size="icon-xs" variant="ghost" aria-label="Delete connection" title="Delete" className="hover:text-danger" onClick={() => setDeleting(c)} disabled={demo}>
                        <Trash2 />
                      </Button>
                    </div>
                  )}
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      </div>

      {dialog && <ConnectionDialog key={dialog.connection?.id ?? "new"} open onClose={() => setDialog(null)} connection={dialog.connection} />}
      <ConfirmDialog
        open={!!deleting}
        onClose={() => setDeleting(null)}
        title={`Remove "${deleting?.name}"`}
        description="Only the dashboard entry is removed. Nothing in Redis is touched. Folders and alerts pointing at this connection stop working."
        confirmText="Remove connection"
        danger
        typeToConfirm={deleting?.name}
        loading={del.isPending}
        onConfirm={() => deleting && del.mutate(deleting.id, { onSuccess: () => (setDeleting(null), toast.success("Connection removed")), onError: (e) => toast.error(errorMessage(e)) })}
      />
    </div>
  );
}

function ConnectionDialog({ open, onClose, connection }: { open: boolean; onClose: () => void; connection: RedisConnection | null }) {
  const create = useCreateConnection();
  const update = useUpdateConnection();
  const test = useTestConnection();
  const [form, setForm] = useState({
    name: connection?.name ?? "",
    url: connection ? "" : "redis://localhost:6379",
    prefix: connection?.prefix ?? "bull",
    cluster: connection?.cluster ?? false,
    queueFilter: connection?.queueFilter ?? "",
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [ping, setPing] = useState<PingResult | null>(null);
  /**
   * Two ways to say where Redis is. Fields are the default because that is how
   * providers hand out credentials; the URL mode is for people who already have
   * one. Both end up as the same `url` on the wire.
   */
  const [mode, setMode] = useState<"fields" | "url">("fields");
  const initialParts = connection ? partsFromUrl(connection.url) : DEFAULT_REDIS_PARTS;
  const [parts, setParts] = useState<RedisParts>(initialParts);

  const set = (k: keyof typeof form, v: string | boolean) => {
    setForm((f) => ({ ...f, [k]: v }));
    setPing(null);
  };
  const setPart = (k: keyof RedisParts, v: string | boolean) => {
    setParts((p) => ({ ...p, [k]: v }));
    setPing(null);
  };

  /**
   * The URL the form currently describes; "" means "keep the stored one" when
   * editing. In fields mode an untouched form with an empty password keeps the
   * stored URL, so opening Edit and pressing Save never drops the password.
   */
  const effectiveUrl = (): string => {
    if (mode === "url") return form.url.trim();
    if (connection && !parts.password && !partsChanged(parts, initialParts)) return "";
    return urlFromParts(parts);
  };

  const buildInput = (): CreateConnectionInput | null => {
    const url = effectiveUrl();
    const raw = {
      name: form.name.trim(),
      url,
      prefix: form.prefix.trim() || "bull",
      cluster: form.cluster,
      queueFilter: form.queueFilter.trim() || null,
    };
    // when editing, an empty URL means "keep the current one"
    if (connection && !raw.url) raw.url = connection.url;
    const parsed = createConnectionSchema.safeParse(raw);
    if (!parsed.success) {
      const next: Record<string, string> = {};
      for (const i of parsed.error.issues) next[String(i.path[0])] = i.message;
      setErrors(next);
      return null;
    }
    setErrors({});
    return parsed.data;
  };

  const submit = () => {
    const input = buildInput();
    if (!input) return;
    const done = (c: RedisConnection) => {
      toast.success(`Connection "${c.name}" saved`);
      onClose();
    };
    if (connection) {
      const patch: Partial<CreateConnectionInput> = { name: input.name, prefix: input.prefix, cluster: input.cluster, queueFilter: input.queueFilter };
      if (effectiveUrl()) patch.url = input.url;
      update.mutate({ id: connection.id, input: patch }, { onSuccess: done, onError: (e) => toast.error(errorMessage(e)) });
    } else {
      create.mutate(input, { onSuccess: done, onError: (e) => toast.error(errorMessage(e)) });
    }
  };

  const runTest = () => {
    const url = effectiveUrl();
    if (!url) {
      setErrors({ url: connection ? (mode === "url" ? "Enter the URL (with password) to test it" : "Enter the password to test the stored connection") : "URL is required" });
      return;
    }
    test.mutate({ url, prefix: form.prefix.trim() || undefined, cluster: form.cluster }, { onSuccess: setPing, onError: (e) => setPing({ ok: false, error: errorMessage(e) }) });
  };

  const busy = create.isPending || update.isPending;

  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="md"
      title={connection ? `Edit ${connection.name}` : "Add connection"}
      description="Credentials are stored server-side and never sent back to the browser."
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="secondary" size="sm" leftIcon={<Plug />} onClick={runTest} loading={test.isPending}>
            Test connection
          </Button>
          <Button variant="primary" size="sm" onClick={submit} loading={busy}>
            {connection ? "Save" : "Add connection"}
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
        <Input label="Name" autoFocus value={form.name} onChange={(e) => set("name", e.target.value)} error={errors.name} placeholder="production" />
        <div className="flex items-center justify-between">
          <span className="text-xs font-medium text-fg-muted">Redis</span>
          <div className="inline-flex rounded-md border border-border p-0.5 text-xs" role="tablist" aria-label="How to enter the Redis address">
            {(["fields", "url"] as const).map((m) => (
              <button key={m} type="button" role="tab" aria-selected={mode === m} className={`rounded px-2 py-0.5 ${mode === m ? "bg-surface-3 text-fg" : "text-fg-muted hover:text-fg"}`} onClick={() => (setMode(m), setPing(null))}>
                {m === "fields" ? "Host & password" : "Connection URL"}
              </button>
            ))}
          </div>
        </div>
        {mode === "url" ? (
          <Input
            label="Redis URL"
            mono
            value={form.url}
            onChange={(e) => set("url", e.target.value)}
            error={errors.url}
            placeholder={connection ? `${connection.url} (leave empty to keep)` : "redis://:password@host:6379/0"}
            hint="redis:// or rediss:// (TLS). Include the password; it is redacted everywhere in the UI."
            autoComplete="off"
            spellCheck={false}
          />
        ) : (
          <div className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-[1fr_120px]">
              <Input label="Host" mono value={parts.host} onChange={(e) => setPart("host", e.target.value)} placeholder="cache.internal" autoComplete="off" spellCheck={false} />
              <Input label="Port" mono inputMode="numeric" value={parts.port} onChange={(e) => setPart("port", e.target.value)} />
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <Input label="Username (optional)" mono value={parts.username} onChange={(e) => setPart("username", e.target.value)} placeholder="default" autoComplete="off" spellCheck={false} />
              <Input
                label="Password"
                type="password"
                mono
                value={parts.password}
                onChange={(e) => setPart("password", e.target.value)}
                placeholder={connection ? "leave empty to keep the stored one" : "optional"}
                hint={connection ? "Stored server-side and never shown again. Changing the host or TLS needs it typed again." : "Stored server-side, redacted everywhere in the UI."}
                autoComplete="new-password"
              />
            </div>
            <div className="grid items-end gap-3 sm:grid-cols-[120px_1fr]">
              <Input label="Database" mono inputMode="numeric" value={parts.db} onChange={(e) => setPart("db", e.target.value)} />
              <div className="flex items-start gap-2.5 pb-1">
                <Switch checked={parts.tls} onChange={(v) => setPart("tls", v)} label="TLS" className="mt-0.5" />
                <button type="button" className="text-left text-xs" onClick={() => setPart("tls", !parts.tls)}>
                  <span className="font-medium text-fg">TLS</span>
                  <span className="text-fg-muted"> (rediss://) — required by ElastiCache with in-transit encryption, Redis Cloud, Upstash and most managed Redis.</span>
                </button>
              </div>
            </div>
            {errors.url && <p className="text-xs text-danger">{errors.url}</p>}
            <p className="font-mono text-[11px] text-fg-subtle">{effectiveUrl() ? urlFromParts({ ...parts, password: parts.password ? "****" : "" }) : `${connection?.url ?? ""} (unchanged)`}</p>
          </div>
        )}
        <div className="grid gap-3 sm:grid-cols-2">
          <Input label="Key prefix" mono value={form.prefix} onChange={(e) => set("prefix", e.target.value)} error={errors.prefix} hint="BullMQ default is bull" />
          <Input label="Queue filter (optional)" mono value={form.queueFilter} onChange={(e) => set("queueFilter", e.target.value)} error={errors.queueFilter} placeholder="payments-*" hint="Glob over queue names; limits discovery." />
        </div>
        <Checkbox label="Redis Cluster" description="Use cluster-aware client. Each queue lives in one hash slot, so all reads stay single-node." checked={form.cluster} onChange={(e) => set("cluster", e.target.checked)} />

        {ping && (
          <div className={`flex items-start gap-2 rounded-md border px-3 py-2 text-xs ${ping.ok ? "border-success/40 bg-success/10 text-success" : "border-danger/40 bg-danger/10 text-danger"}`} role="status">
            {ping.ok ? <CheckCircle2 className="mt-px size-4 shrink-0" /> : <XCircle className="mt-px size-4 shrink-0" />}
            <div>
              {ping.ok ? (
                <>
                  Connected{ping.latencyMs != null && ` in ${ping.latencyMs} ms`}
                  {ping.redisVersion && ` · Redis ${ping.redisVersion}`}
                  {ping.queuesFound != null && ` · ${ping.queuesFound} queues found`}
                </>
              ) : (
                <>Failed: {ping.error ?? "unknown error"}</>
              )}
            </div>
          </div>
        )}
      </form>
    </Dialog>
  );
}
