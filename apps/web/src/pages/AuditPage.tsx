import { useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { ChevronDown, ChevronRight, Download, ScrollText, ShieldAlert, X } from "lucide-react";
import {
  AUDIT_ACTION_LABEL,
  AUDIT_ACTIONS,
  AUDIT_HIGH_RISK_ACTIONS,
  type AuditAction,
  type AuditEntry,
} from "@bullmq-visualizer/shared";
import { cn } from "@/lib/cn";
import { routes } from "@/lib/routes";
import { formatDateTime } from "@/lib/format";
import { auditExportUrl, useAudit, useAuditActors, useConnections, type AuditFilters } from "@/api/hooks";
import { errorMessage } from "@/api/client";
import { RequireRole } from "@/auth/guards";
import { useEdition } from "@/edition/useEdition";
import { LockedFeature } from "@/edition/LockedFeature";
import { Page, PageHeader } from "@/components/layout/AppShell";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { Input, Select } from "@/components/ui/Input";
import { Table, TableMessage, Td, Th } from "@/components/ui/Table";
import { RelativeTime } from "@/components/ui/RelativeTime";
import { Spinner } from "@/components/ui/Spinner";
import { Tooltip } from "@/components/ui/Tooltip";
import { EmptyState } from "@/components/ui/EmptyState";
import { JsonView } from "@/components/ui/JsonView";

const PAGE_SIZE = 50;
const HIGH_RISK = new Set<AuditAction>(AUDIT_HIGH_RISK_ACTIONS);

export function AuditPage() {
  const { has } = useEdition();
  if (!has("audit")) return <LockedFeature feature="audit" />;
  return (
    <RequireRole role="admin">
      <AuditLog />
    </RequireRole>
  );
}

/**
 * Filters live in the URL, not in component state: "the audit of the payments
 * queue between the 3rd and the 5th" is a link you paste into a ticket, and the
 * queue page and job page deep-link straight into it.
 */
function useFilters(): [AuditFilters, (patch: Partial<AuditFilters>) => void, () => void] {
  const [sp, setSp] = useSearchParams();
  const filters: AuditFilters = useMemo(() => {
    const action = sp.get("action");
    const result = sp.get("result");
    return {
      actorId: sp.get("actorId") || undefined,
      action: action && (AUDIT_ACTIONS as readonly string[]).includes(action) ? (action as AuditAction) : undefined,
      connectionId: sp.get("connectionId") || undefined,
      queueName: sp.get("queueName") || undefined,
      jobId: sp.get("jobId") || undefined,
      result: result === "ok" || result === "error" ? result : undefined,
      from: sp.get("from") || undefined,
      to: sp.get("to") || undefined,
    };
  }, [sp]);

  const set = (patch: Partial<AuditFilters>) => {
    setSp(
      (prev) => {
        const next = new URLSearchParams(prev);
        for (const [k, v] of Object.entries(patch)) {
          if (!v) next.delete(k);
          else next.set(k, v);
        }
        return next;
      },
      { replace: true },
    );
  };
  const clear = () => setSp(new URLSearchParams(), { replace: true });
  return [filters, set, clear];
}

/** `<input type="date">` value ⇄ the ISO instants the API wants. */
const dateToIso = (d: string, endOfDay: boolean): string | undefined =>
  d ? new Date(`${d}T${endOfDay ? "23:59:59.999" : "00:00:00.000"}Z`).toISOString() : undefined;
const isoToDate = (iso: string | undefined): string => (iso ? iso.slice(0, 10) : "");

function AuditLog() {
  const [filters, setFilter, clearFilters] = useFilters();
  const connections = useConnections();
  const actors = useAuditActors();
  const audit = useAudit(filters, PAGE_SIZE);
  const [expanded, setExpanded] = useState<string | null>(null);

  const entries = audit.data?.pages.flatMap((p) => p.entries) ?? [];
  const activeCount = Object.values(filters).filter(Boolean).length;
  const connectionName = (id: string | null) =>
    connections.data?.find((c) => c.id === id)?.name ?? null;

  return (
    <Page wide>
      <PageHeader
        title="Audit log"
        description="Every mutating action, who did it and whether it worked. Append-only: nothing here can be edited or deleted from the UI."
        actions={
          <>
            {activeCount > 0 && (
              <Button size="sm" variant="ghost" leftIcon={<X />} onClick={clearFilters}>
                Clear filters
              </Button>
            )}
            {/* A plain link, not a fetch: the browser downloads a 50k-row CSV
                without holding it in JS memory, and the session cookie rides along. */}
            <a
              href={auditExportUrl(filters)}
              className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md border border-border bg-surface-2 px-2.5 text-xs font-medium text-fg hover:border-border-strong hover:bg-surface-3 [&_svg]:size-3.5"
            >
              <Download aria-hidden />
              Export CSV
            </a>
          </>
        }
      />

      <div className="card mb-3 flex flex-wrap items-end gap-2 p-3">
        <Select
          label="Who"
          className="!h-7 w-44 text-xs"
          value={filters.actorId ?? ""}
          onChange={(e) => setFilter({ actorId: e.target.value })}
          options={[
            { value: "", label: "Anyone" },
            // People who have since been deleted are still here: the actor is
            // denormalised into the log precisely so they stay filterable.
            ...(actors.data ?? [])
              .filter((a) => a.id)
              .map((a) => ({ value: a.id as string, label: a.name ?? a.email ?? (a.id as string) })),
          ]}
        />
        <Select
          label="Action"
          className="!h-7 w-52 text-xs"
          value={filters.action ?? ""}
          onChange={(e) => setFilter({ action: e.target.value as AuditAction })}
          options={[
            { value: "", label: "Any action" },
            ...AUDIT_ACTIONS.map((a) => ({ value: a, label: `${AUDIT_ACTION_LABEL[a]} (${a})` })),
          ]}
        />
        <Select
          label="Connection"
          className="!h-7 w-40 text-xs"
          value={filters.connectionId ?? ""}
          onChange={(e) => setFilter({ connectionId: e.target.value })}
          options={[
            { value: "", label: "Any connection" },
            ...(connections.data ?? []).map((c) => ({ value: c.id, label: c.name })),
          ]}
        />
        <Input
          label="Queue"
          className="!h-7 w-40 text-xs"
          placeholder="exact name"
          value={filters.queueName ?? ""}
          onChange={(e) => setFilter({ queueName: e.target.value })}
        />
        <Select
          label="Result"
          className="!h-7 w-32 text-xs"
          value={filters.result ?? ""}
          onChange={(e) => setFilter({ result: e.target.value as "ok" | "error" })}
          options={[
            { value: "", label: "Any result" },
            { value: "ok", label: "ok" },
            { value: "error", label: "refused / failed" },
          ]}
        />
        <Input
          label="From"
          type="date"
          className="!h-7 w-36 text-xs"
          value={isoToDate(filters.from)}
          onChange={(e) => setFilter({ from: dateToIso(e.target.value, false) })}
        />
        <Input
          label="To"
          type="date"
          className="!h-7 w-36 text-xs"
          value={isoToDate(filters.to)}
          onChange={(e) => setFilter({ to: dateToIso(e.target.value, true) })}
        />
        {filters.jobId && (
          <Badge variant="outline" mono className="mb-1">
            job {filters.jobId}
            <button type="button" aria-label="Clear job filter" onClick={() => setFilter({ jobId: undefined })}>
              <X className="size-3" />
            </button>
          </Badge>
        )}
      </div>

      <div className="card overflow-hidden">
        <Table dense>
          <thead>
            <tr>
              <Th className="w-8" />
              <Th className="w-32">When</Th>
              <Th className="w-56">Who</Th>
              <Th className="w-56">Action</Th>
              <Th>Target</Th>
              <Th className="w-28">Result</Th>
              <Th className="w-32">IP</Th>
            </tr>
          </thead>
          <tbody>
            {audit.isLoading && (
              <TableMessage colSpan={7}>
                <Spinner label="Loading the audit log…" />
              </TableMessage>
            )}
            {audit.isError && (
              <TableMessage colSpan={7} className="text-danger">
                {errorMessage(audit.error)}
              </TableMessage>
            )}
            {!audit.isLoading && !audit.isError && entries.length === 0 && (
              <TableMessage colSpan={7}>
                <EmptyState
                  compact
                  icon={<ScrollText />}
                  title={activeCount > 0 ? "Nothing matches these filters" : "Nothing recorded yet"}
                  description={
                    activeCount > 0
                      ? "Widen the date range or clear a filter."
                      : "The log fills as people act: pausing a queue, retrying a job, inviting a user. Reads are never recorded."
                  }
                />
              </TableMessage>
            )}
            {entries.map((e) => (
              <Row
                key={e.id}
                entry={e}
                open={expanded === e.id}
                onToggle={() => setExpanded(expanded === e.id ? null : e.id)}
                connectionStillExists={!!connectionName(e.connectionId)}
              />
            ))}
          </tbody>
        </Table>
      </div>

      <div className="mt-3 flex items-center justify-between gap-3 text-xs text-fg-muted">
        <span className="num">
          {entries.length} {entries.length === 1 ? "entry" : "entries"} loaded
        </span>
        {audit.hasNextPage && (
          <Button size="sm" variant="secondary" loading={audit.isFetchingNextPage} onClick={() => void audit.fetchNextPage()}>
            Load 50 more
          </Button>
        )}
      </div>

      <p className="mt-4 text-xs text-fg-subtle">
        Retention is <code className="font-mono">BMV_AUDIT_RETENTION_DAYS</code> (default 365). Rows leave only by age —
        there is no delete endpoint, on purpose. The job payload is never recorded: <code className="font-mono">detail</code>{" "}
        holds the parameters of an action and, where it helps, the payload size in bytes.
      </p>
    </Page>
  );
}

function Row({
  entry,
  open,
  onToggle,
  connectionStillExists,
}: {
  entry: AuditEntry;
  open: boolean;
  onToggle: () => void;
  connectionStillExists: boolean;
}) {
  const risky = HIGH_RISK.has(entry.action);
  const failed = entry.result === "error";
  const hasDetail = !!entry.detail || !!entry.userAgent || !!entry.errorMessage;

  return (
    <>
      <tr className={cn(failed && "bg-danger/5")}>
        <Td>
          {hasDetail ? (
            <button
              type="button"
              aria-label={open ? "Hide detail" : "Show detail"}
              aria-expanded={open}
              onClick={onToggle}
              className="rounded p-0.5 text-fg-subtle hover:text-fg"
            >
              {open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
            </button>
          ) : null}
        </Td>
        <Td muted>
          {/* Relative for scanning, absolute on hover for the report. */}
          <RelativeTime value={entry.createdAt} />
        </Td>
        <Td>
          {entry.actorName || entry.actorEmail ? (
            <div className="flex min-w-0 items-center gap-1.5">
              <span className="truncate font-medium">{entry.actorName ?? "—"}</span>
              {entry.actorRole && (
                <Badge size="xs" variant={entry.actorRole === "admin" ? "pro" : entry.actorRole === "operator" ? "info" : "neutral"}>
                  {entry.actorRole}
                </Badge>
              )}
              {entry.actorEmail && <span className="truncate text-[11px] text-fg-subtle">{entry.actorEmail}</span>}
            </div>
          ) : (
            <Tooltip content="No session — an anonymous request, e.g. a failed login on an unknown email">
              <span className="cursor-help text-fg-subtle">anonymous</span>
            </Tooltip>
          )}
        </Td>
        <Td>
          <div className="flex items-center gap-1.5">
            {risky && <ShieldAlert className="size-3.5 shrink-0 text-warning" aria-label="High-risk action" />}
            <span className={cn(risky && "font-medium")}>{AUDIT_ACTION_LABEL[entry.action]}</span>
            <Tooltip content={entry.action}>
              <code className="cursor-help font-mono text-[10px] text-fg-subtle">{entry.action}</code>
            </Tooltip>
          </div>
        </Td>
        <Td>
          <Target entry={entry} connectionStillExists={connectionStillExists} />
        </Td>
        <Td>
          {failed ? (
            <Tooltip content={entry.errorMessage ?? "The action was refused or failed"}>
              <Badge variant="danger" size="xs" className="cursor-help">
                refused
              </Badge>
            </Tooltip>
          ) : (
            <Badge variant="success" size="xs">
              ok
            </Badge>
          )}
        </Td>
        <Td muted mono>
          {entry.ip ?? "–"}
        </Td>
      </tr>
      {open && (
        <tr>
          <td colSpan={7} className="bg-surface-2 !px-4 !py-3">
            <dl className="grid gap-3 text-xs sm:grid-cols-[10rem_1fr]">
              <dt className="text-fg-subtle">Exact time</dt>
              <dd className="num">{formatDateTime(entry.createdAt)}</dd>
              {entry.errorMessage && (
                <>
                  <dt className="text-fg-subtle">Why it failed</dt>
                  <dd className="text-danger">{entry.errorMessage}</dd>
                </>
              )}
              {entry.userAgent && (
                <>
                  <dt className="text-fg-subtle">User agent</dt>
                  <dd className="font-mono text-[11px] break-all text-fg-muted">{entry.userAgent}</dd>
                </>
              )}
              <dt className="text-fg-subtle">
                Detail
                <span className="mt-0.5 block text-[10px] text-fg-subtle">parameters only — never the job payload</span>
              </dt>
              <dd>
                {entry.detail ? (
                  <JsonView value={entry.detail} defaultExpandDepth={3} />
                ) : (
                  <span className="text-fg-subtle">no parameters recorded</span>
                )}
              </dd>
            </dl>
          </td>
        </tr>
      )}
    </>
  );
}

/**
 * Connection / queue / job, linked while the target still exists. A deleted
 * connection stays readable because the log kept its NAME, which is the whole
 * reason the column is denormalised.
 */
function Target({ entry, connectionStillExists }: { entry: AuditEntry; connectionStillExists: boolean }) {
  if (!entry.connectionId && !entry.queueName) {
    return <span className="text-fg-subtle">–</span>;
  }
  const label = entry.connectionName ?? entry.connectionId;
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-1 text-xs">
      {label && (
        <>
          {connectionStillExists && entry.connectionId ? (
            <Link to={routes.connection(entry.connectionId)} className="text-accent hover:underline">
              {label}
            </Link>
          ) : (
            <Tooltip content="This connection no longer exists — the name is the one it had at the time">
              <span className="cursor-help text-fg-muted line-through">{label}</span>
            </Tooltip>
          )}
        </>
      )}
      {entry.queueName && (
        <>
          <span className="text-fg-subtle">/</span>
          {connectionStillExists && entry.connectionId ? (
            <Link to={routes.queue(entry.connectionId, entry.queueName)} className="font-mono text-accent hover:underline">
              {entry.queueName}
            </Link>
          ) : (
            <span className="font-mono text-fg-muted line-through">{entry.queueName}</span>
          )}
        </>
      )}
      {entry.jobId && (
        <>
          <span className="text-fg-subtle">/</span>
          {connectionStillExists && entry.connectionId && entry.queueName ? (
            <Link
              to={routes.job(entry.connectionId, entry.queueName, entry.jobId)}
              className="font-mono text-accent hover:underline"
              title="The job may have been removed since"
            >
              #{entry.jobId}
            </Link>
          ) : (
            <span className="font-mono text-fg-muted">#{entry.jobId}</span>
          )}
        </>
      )}
    </div>
  );
}
