import { useState } from "react";
import { Bot, TriangleAlert, Unplug } from "lucide-react";
import type { McpAccessLevel, McpGrant } from "@bullpane/shared";
import { useMcpGrants, useMcpSettings, useRevokeMcpGrant, useSetMcpSettings } from "@/api/hooks";
import { errorMessage } from "@/api/client";
import { useAuth } from "@/auth/AuthProvider";
import { useEdition } from "@/edition/useEdition";
import { LockedFeature } from "@/edition/LockedFeature";
import { toast } from "@/components/Toast";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Select } from "@/components/ui/Input";
import { Spinner } from "@/components/ui/Spinner";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { formatRelative } from "@/lib/format";
import { CopyRow } from "./SsoTab";

const LEVELS: { value: McpAccessLevel; label: string; hint: string }[] = [
  { value: "off", label: "Off", hint: "No MCP client can connect or call anything." },
  { value: "read", label: "Read only", hint: "Clients can list queues, read jobs, logs and schedulers. Nothing changes." },
  {
    value: "write",
    label: "Read & write",
    hint: "Operators and admins may also let a client retry, promote, remove and add jobs and pause queues. Viewers still only read.",
  },
];

export function McpTab() {
  const { has } = useEdition();
  if (!has("mcp")) return <LockedFeature feature="mcp" />;
  return <McpManager />;
}

function McpManager() {
  const { isAdmin } = useAuth();
  const settings = useMcpSettings();
  const setSettings = useSetMcpSettings();
  const [showAll, setShowAll] = useState(false);
  const grants = useMcpGrants(isAdmin && showAll);
  const revoke = useRevokeMcpGrant();
  const [revoking, setRevoking] = useState<McpGrant | null>(null);

  if (settings.isLoading || !settings.data) {
    return (
      <div className="flex justify-center py-8">
        <Spinner />
      </div>
    );
  }
  const { maxAccess, endpoint, reachableFromCloud } = settings.data;
  const list = grants.data ?? [];

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-sm font-semibold text-fg">MCP for Claude</h2>
        <p className="mt-1 max-w-2xl text-xs text-fg-muted">
          Connect Claude to this Bullpane. Each person signs in with their own Bullpane login (or SSO) and picks read or read &amp; write.
          A client acts as that person, with their role: what they cannot do in the dashboard, Claude cannot do either. Every change
          is in the audit log, and draining, cleaning or obliterating a queue always comes back here for a human to confirm.
        </p>
      </div>

      <div className="card space-y-3 p-4">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-fg-subtle">Access for MCP clients</h3>
        <Select
          label="Most a client can do on this install"
          value={maxAccess}
          disabled={!isAdmin || setSettings.isPending}
          onChange={(e) =>
            setSettings.mutate(
              { maxAccess: e.target.value as McpAccessLevel },
              {
                onSuccess: () => toast.success("MCP access updated. It applies to connected clients on their next call."),
                onError: (err) => toast.error(errorMessage(err)),
              },
            )
          }
          options={LEVELS.map((l) => ({ value: l.value, label: l.label }))}
          hint={isAdmin ? LEVELS.find((l) => l.value === maxAccess)?.hint : "Only an admin can change this."}
          wrapperClassName="max-w-md"
        />
      </div>

      <div className="card space-y-3 p-4">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-fg-subtle">Connect a client</h3>
        <CopyRow label="Server URL" value={endpoint} />
        {!reachableFromCloud && (
          <div className="flex gap-2 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-fg">
            <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-warning" />
            <span>
              claude.ai and Claude Desktop connect from Anthropic's cloud, so they need this URL to be public HTTPS. It looks private
              (check <span className="font-mono">PUBLIC_URL</span>). Claude Code connects from your machine and works on a private network.
            </span>
          </div>
        )}
        <dl className="space-y-2 text-xs text-fg-muted">
          <div>
            <dt className="font-medium text-fg">claude.ai and Claude Desktop</dt>
            <dd>Settings → Connectors → Add custom connector, paste the server URL, then Connect and sign in.</dd>
          </div>
          <div>
            <dt className="font-medium text-fg">Claude Code</dt>
            <dd>
              <code className="rounded bg-surface-2 px-1.5 py-0.5 font-mono text-[11px]">claude mcp add --transport http bullpane {endpoint}</code>
              , then run <code className="font-mono">/mcp</code> to sign in.
            </dd>
          </div>
        </dl>
      </div>

      <div className="space-y-2">
        <div className="flex items-center justify-between gap-3">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-fg-subtle">{showAll ? "All connected clients" : "Your connected clients"}</h3>
          {isAdmin && (
            <Button size="sm" variant="ghost" onClick={() => setShowAll((v) => !v)}>
              {showAll ? "Show only mine" : "Show everyone's"}
            </Button>
          )}
        </div>
        {grants.isLoading ? (
          <div className="flex justify-center py-6">
            <Spinner />
          </div>
        ) : list.length === 0 ? (
          <div className="card p-6 text-center">
            <Bot className="mx-auto size-6 text-fg-subtle" />
            <p className="mt-2 text-sm text-fg">No client connected</p>
            <p className="mx-auto mt-1 max-w-md text-xs text-fg-muted">Add the server URL to Claude and sign in; the connection shows up here.</p>
          </div>
        ) : (
          <div className="card divide-y divide-border">
            {list.map((g) => (
              <div key={g.id} className="flex items-center justify-between gap-3 px-4 py-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm font-medium text-fg">{g.clientName}</span>
                    <Badge variant={g.access === "write" ? "warning" : "neutral"}>{g.access === "write" ? "read & write" : "read"}</Badge>
                  </div>
                  <p className="mt-0.5 truncate text-xs text-fg-muted">
                    {showAll && <>{g.userEmail} · </>}
                    {g.redirectHost} · connected {formatRelative(g.createdAt)} · {g.lastUsedAt ? `last used ${formatRelative(g.lastUsedAt)}` : "not used yet"}
                  </p>
                </div>
                <Button size="sm" variant="ghost" leftIcon={<Unplug className="size-3.5" />} onClick={() => setRevoking(g)}>
                  Disconnect
                </Button>
              </div>
            ))}
          </div>
        )}
      </div>

      <ConfirmDialog
        open={revoking !== null}
        onClose={() => setRevoking(null)}
        title="Disconnect client"
        description={revoking ? `${revoking.clientName} (${revoking.userEmail}) loses access on its next call. Connecting again needs a new sign-in.` : undefined}
        confirmText="Disconnect"
        danger
        loading={revoke.isPending}
        onConfirm={() =>
          revoking &&
          revoke.mutate(revoking.id, {
            onSuccess: () => {
              toast.success(`${revoking.clientName} disconnected`);
              setRevoking(null);
            },
            onError: (err) => toast.error(errorMessage(err)),
          })
        }
      />
    </div>
  );
}
