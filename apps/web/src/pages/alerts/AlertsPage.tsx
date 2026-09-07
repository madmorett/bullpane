import { useState } from "react";
import { Bell, BellRing, Pencil, Plus, Send, Trash2 } from "lucide-react";
import type { Alert, AlertCondition, AlertEvent } from "@bullmq-visualizer/shared";
import { cn } from "@/lib/cn";
import { formatNumber } from "@/lib/format";
import { useAlertEvents, useAlerts, useConnections, useDeleteAlert, useFolders, useTestAlert, useUpdateAlert } from "@/api/hooks";
import { errorMessage } from "@/api/client";
import { useAuth } from "@/auth/AuthProvider";
import { useEdition } from "@/edition/useEdition";
import { LockedFeature } from "@/edition/LockedFeature";
import { toast } from "@/components/Toast";
import { Page, PageHeader } from "@/components/layout/AppShell";
import { Button } from "@/components/ui/Button";
import { Badge, type BadgeVariant } from "@/components/ui/Badge";
import { Switch, Select } from "@/components/ui/Input";
import { Table, TableMessage, Td, Th, Tr } from "@/components/ui/Table";
import { RelativeTime } from "@/components/ui/RelativeTime";
import { Spinner } from "@/components/ui/Spinner";
import { EmptyState } from "@/components/ui/EmptyState";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { AlertDialog } from "./AlertDialog";
import { MeasurementBadge } from "./MetricsRequirement";

export function AlertsPage() {
  const { has } = useEdition();
  if (!has("alerts")) return <LockedFeature feature="alerts" />;
  return <AlertsManager />;
}

export function describeCondition(c: AlertCondition): string {
  switch (c.kind) {
    case "waiting_above":
      return `wait+prioritized > ${formatNumber(c.threshold)}`;
    case "failed_above":
      return `failed > ${formatNumber(c.threshold)} in ${c.windowMinutes}m`;
    case "failed_rate_above":
      return `failure rate > ${c.percent}% in ${c.windowMinutes}m (min ${c.minSample})`;
  }
}

const EVENT_VARIANT: Record<AlertEvent["status"], BadgeVariant> = {
  fired: "danger",
  resolved: "success",
  delivery_failed: "warning",
  // informative, not an incident: the alert could not measure and did NOT fire
  no_metrics: "info",
};

function AlertsManager() {
  const { isOperator } = useAuth();
  const alerts = useAlerts();
  const connections = useConnections();
  const folders = useFolders();
  const update = useUpdateAlert();
  const del = useDeleteAlert();
  const test = useTestAlert();
  const [dialog, setDialog] = useState<null | { alert: Alert | null }>(null);
  const [deleting, setDeleting] = useState<Alert | null>(null);
  const [eventFilter, setEventFilter] = useState<string>("");
  const events = useAlertEvents({ limit: 100, alertId: eventFilter || undefined });

  const connName = (id: string | null) => (id ? connections.data?.find((c) => c.id === id)?.name ?? id : "–");
  const folderName = (id: string) => folders.data?.find((f) => f.id === id)?.name ?? id;
  const list = [...(alerts.data ?? [])].sort((a, b) => Number(b.firing) - Number(a.firing) || a.name.localeCompare(b.name));
  const firing = list.filter((a) => a.firing).length;

  return (
    <Page>
      <PageHeader
        title={
          <span className="flex items-center gap-2">
            Alerts
            {firing > 0 && (
              <Badge variant="danger" dot>
                {firing} firing
              </Badge>
            )}
          </span>
        }
        description="Server-side rules: backlog from live counts, failures from BullMQ metrics counters. Delivered to Slack or any webhook."
        actions={
          isOperator && (
            <Button variant="primary" size="sm" leftIcon={<Plus />} onClick={() => setDialog({ alert: null })}>
              New alert
            </Button>
          )
        }
      />

      <div className="card overflow-hidden">
        <Table>
          <thead>
            <tr>
              <Th className="w-16">State</Th>
              <Th>Name</Th>
              <Th>Scope</Th>
              <Th>Condition</Th>
              <Th>Channels</Th>
              <Th>Last fired</Th>
              <Th align="right">
                <span className="sr-only">Actions</span>
              </Th>
            </tr>
          </thead>
          <tbody>
            {alerts.isLoading && (
              <TableMessage colSpan={7}>
                <Spinner label="Loading alerts…" />
              </TableMessage>
            )}
            {alerts.isError && (
              <TableMessage colSpan={7} className="text-danger">
                {errorMessage(alerts.error)}
              </TableMessage>
            )}
            {alerts.data && list.length === 0 && (
              <tr>
                <td colSpan={7}>
                  <EmptyState
                    compact
                    icon={<Bell />}
                    title="No alerts yet"
                    description="Start with 'failures above threshold' on your most important queue and a Slack webhook."
                    action={
                      isOperator && (
                        <Button size="sm" variant="primary" leftIcon={<Plus />} onClick={() => setDialog({ alert: null })}>
                          New alert
                        </Button>
                      )
                    }
                  />
                </td>
              </tr>
            )}
            {list.map((a) => (
              <Tr key={a.id} className={cn(!a.enabled && "opacity-60")}>
                <Td>
                  {a.firing ? (
                    <Badge variant="danger" dot>
                      <BellRing className="size-3" /> firing
                    </Badge>
                  ) : a.enabled ? (
                    // Never a bare green "ok": an alert that cannot measure
                    // (no worker metrics) or has no history yet says so.
                    <MeasurementBadge measurement={a.measurement} />
                  ) : (
                    <Badge variant="neutral">off</Badge>
                  )}
                </Td>
                <Td className="font-medium">{a.name}</Td>
                <Td muted>
                  {a.scope.type === "queue" ? (
                    <>
                      {connName(a.scope.connectionId)}
                      <span className="text-fg-subtle"> / </span>
                      <span className="font-mono text-xs">{a.scope.queueName}</span>
                    </>
                  ) : (
                    <span className="inline-flex items-center gap-1">
                      <Badge variant="outline" size="xs">
                        folder
                      </Badge>
                      {folderName(a.scope.folderId)}
                    </span>
                  )}
                </Td>
                <Td mono>{describeCondition(a.condition)}</Td>
                <Td muted>
                  {a.channels.map((c, i) => (
                    <Badge key={i} variant="outline" size="xs" className="mr-1">
                      {c.type}
                    </Badge>
                  ))}
                  <span className="text-[11px] text-fg-subtle">· cooldown {a.cooldownMinutes}m</span>
                </Td>
                <Td muted>
                  <RelativeTime value={a.lastFiredAt} emptyText="never" />
                </Td>
                <Td align="right">
                  <div className="flex items-center justify-end gap-1">
                    {isOperator && (
                      <Switch
                        size="sm"
                        checked={a.enabled}
                        label={a.enabled ? "Disable alert" : "Enable alert"}
                        disabled={update.isPending && update.variables?.id === a.id}
                        onChange={(v) => update.mutate({ id: a.id, input: { enabled: v } }, { onError: (e) => toast.error(errorMessage(e)) })}
                      />
                    )}
                    {isOperator && (
                      <Button
                        size="icon-xs"
                        variant="ghost"
                        title="Send test notification"
                        aria-label="Send test notification"
                        loading={test.isPending && test.variables === a.id}
                        onClick={() =>
                          test.mutate(a.id, {
                            onSuccess: (r) => {
                              const failed = r.results?.filter((x) => !x.ok) ?? [];
                              if (r.ok && failed.length === 0) toast.success("Test notification sent", `${r.results?.length ?? 0} channel(s) delivered`);
                              else toast.error("Some channels failed", failed.map((f) => `${f.channel}: ${f.error ?? "error"}`).join("; "));
                            },
                            onError: (e) => toast.error(errorMessage(e)),
                          })
                        }
                      >
                        <Send />
                      </Button>
                    )}
                    {isOperator && (
                      <Button size="icon-xs" variant="ghost" title="Edit" aria-label="Edit alert" onClick={() => setDialog({ alert: a })}>
                        <Pencil />
                      </Button>
                    )}
                    {isOperator && (
                      <Button size="icon-xs" variant="ghost" title="Delete" aria-label="Delete alert" className="hover:text-danger" onClick={() => setDeleting(a)}>
                        <Trash2 />
                      </Button>
                    )}
                  </div>
                </Td>
              </Tr>
            ))}
          </tbody>
        </Table>
      </div>

      <section className="mt-6">
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-xs font-semibold tracking-wider text-fg-subtle uppercase">Events</h2>
          <Select aria-label="Filter events by alert" className="!h-7 !w-auto text-xs" value={eventFilter} onChange={(e) => setEventFilter(e.target.value)} options={[{ value: "", label: "All alerts" }, ...list.map((a) => ({ value: a.id, label: a.name }))]} />
        </div>
        <div className="card overflow-hidden">
          <Table dense>
            <thead>
              <tr>
                <Th className="w-28">When</Th>
                <Th className="w-28">Status</Th>
                <Th>Alert</Th>
                <Th>Queue</Th>
                <Th>Message</Th>
                <Th align="right">Value</Th>
              </tr>
            </thead>
            <tbody>
              {events.isLoading && (
                <TableMessage colSpan={6}>
                  <Spinner />
                </TableMessage>
              )}
              {events.data && events.data.length === 0 && <TableMessage colSpan={6}>No events yet</TableMessage>}
              {events.data?.map((ev) => (
                <tr key={ev.id}>
                  <Td muted>
                    <RelativeTime value={ev.createdAt} />
                  </Td>
                  <Td>
                    <Badge variant={EVENT_VARIANT[ev.status]} size="xs" dot>
                      {ev.status.replace("_", " ")}
                    </Badge>
                  </Td>
                  <Td className="font-medium">{ev.alertName}</Td>
                  <Td muted>
                    {connName(ev.connectionId)}
                    {ev.queueName && <span className="text-fg-subtle"> / {ev.queueName}</span>}
                  </Td>
                  <Td className="max-w-lg truncate" title={ev.message}>
                    {ev.message}
                  </Td>
                  <Td num align="right" muted>
                    {ev.value != null ? formatNumber(ev.value) : "–"}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </div>
      </section>

      {dialog && <AlertDialog key={dialog.alert?.id ?? "new"} open onClose={() => setDialog(null)} alert={dialog.alert} />}
      <ConfirmDialog
        open={!!deleting}
        onClose={() => setDeleting(null)}
        title={`Delete "${deleting?.name}"`}
        description="The alert and its history of events are removed."
        confirmText="Delete"
        danger
        loading={del.isPending}
        onConfirm={() => deleting && del.mutate(deleting.id, { onSuccess: () => (setDeleting(null), toast.success("Alert deleted")), onError: (e) => toast.error(errorMessage(e)) })}
      />
    </Page>
  );
}
