import { useMemo, useState } from "react";
import { NavLink, useParams } from "react-router-dom";
import {
  Bell,
  ChevronDown,
  ChevronRight,
  Database,
  Folder,
  FolderLock,
  LayoutDashboard,
  Search,
  Settings,
  Users,
} from "lucide-react";
import type { Folder as FolderModel, ProFeature, QueueSummary, RedisConnection } from "@bullmq-visualizer/shared";
import { cn } from "@/lib/cn";
import { routes } from "@/lib/routes";
import { formatCompact } from "@/lib/format";
import { modKeyLabel } from "@/lib/useHotkey";
import { useAllQueues, useFolders } from "@/api/hooks";
import { useAuth } from "@/auth/AuthProvider";
import { useEdition } from "@/edition/useEdition";
import { openUpsell } from "@/edition/upsellStore";
import { EditionPill, LockIcon } from "@/edition/ProBadge";
import { Kbd } from "@/components/ui/Kbd";
import { Tooltip } from "@/components/ui/Tooltip";
import { ConnectionStatusDot } from "@/components/ConnectionStatusDot";

export function Logo({ className }: { className?: string }) {
  return (
    <span className={cn("inline-flex size-6 items-center justify-center rounded-md bg-[#0b0d10] ring-1 ring-border-strong", className)} aria-hidden>
      <svg viewBox="0 0 32 32" className="size-5">
        <rect x="7" y="8" width="18" height="4" rx="2" fill="#5b8def" />
        <rect x="7" y="14" width="13" height="4" rx="2" fill="#5b8def" opacity=".75" />
        <rect x="7" y="20" width="8" height="4" rx="2" fill="#5b8def" opacity=".5" />
        <circle cx="24" cy="22" r="3" fill="#f85149" />
      </svg>
    </span>
  );
}

interface SidebarProps {
  onOpenSwitcher: () => void;
  onNavigate?: () => void;
  className?: string;
}

export function Sidebar({ onOpenSwitcher, onNavigate, className }: SidebarProps) {
  const { isAdmin } = useAuth();
  const { has } = useEdition();
  const { byConnection, isLoading } = useAllQueues();
  const foldersEnabled = has("folders");
  const folders = useFolders(foldersEnabled);

  const proNav: { to: string; label: string; icon: typeof Bell; feature: ProFeature; adminOnly?: boolean }[] = [
    // Flows is hidden for now — see lib/featureFlags.ts
    { to: routes.alerts, label: "Alerts", icon: Bell, feature: "alerts" },
    { to: routes.users, label: "Users", icon: Users, feature: "users", adminOnly: true },
  ];

  return (
    <aside className={cn("flex h-full w-64 shrink-0 flex-col border-r border-border bg-surface", className)} aria-label="Sidebar">
      <div className="flex h-12 items-center gap-2 border-b border-border px-3">
        <Logo />
        <span className="truncate text-[13px] font-semibold tracking-tight">BullMQ Visualizer</span>
        <EditionPill className="ml-auto" />
      </div>

      <div className="px-2 pt-2">
        <button
          type="button"
          onClick={onOpenSwitcher}
          className="flex h-8 w-full items-center gap-2 rounded-md border border-border bg-bg px-2.5 text-xs text-fg-subtle hover:border-border-strong hover:text-fg-muted"
        >
          <Search className="size-3.5" aria-hidden />
          <span className="flex-1 text-left">Jump to queue…</span>
          <Kbd>{modKeyLabel}</Kbd>
          <Kbd>K</Kbd>
        </button>
      </div>

      <nav className="px-2 pt-2" aria-label="Primary">
        <NavItem to={routes.home} end icon={LayoutDashboard} label="Overview" onNavigate={onNavigate} />
      </nav>

      <div className="mt-2 min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        <SectionLabel>Queues</SectionLabel>

        {foldersEnabled && folders.data && folders.data.length > 0 && (
          <FolderTree folders={folders.data} byConnection={byConnection} onNavigate={onNavigate} />
        )}

        {byConnection.map(({ connection, queues, error }) => (
          <ConnectionGroup
            key={connection.id}
            connection={connection}
            queues={queues}
            error={error}
            onNavigate={onNavigate}
          />
        ))}

        {!isLoading && byConnection.length === 0 && (
          <p className="px-2 py-3 text-xs text-fg-subtle">
            No connections yet.{" "}
            {isAdmin ? (
              <NavLink to={routes.settings("connections")} className="text-accent hover:underline" onClick={onNavigate}>
                Add one
              </NavLink>
            ) : (
              "Ask an admin to add one."
            )}
          </p>
        )}

        {isLoading && (
          <div className="space-y-2 px-2 py-2">
            <span className="skeleton block h-3 w-3/4" />
            <span className="skeleton block h-3 w-1/2" />
            <span className="skeleton block h-3 w-2/3" />
          </div>
        )}

        {foldersEnabled ? (
          <NavItem to={routes.folders} icon={Folder} label="Manage folders" className="mt-1 text-xs" onNavigate={onNavigate} />
        ) : (
          <button
            type="button"
            onClick={() => openUpsell("folders")}
            className="nav-item mt-1 w-full text-left"
            title="Custom folders are a Pro feature"
          >
            <FolderLock className="size-3.5 shrink-0 text-fg-subtle" aria-hidden />
            <span className="flex-1 truncate text-xs">Custom folders</span>
            <LockIcon />
          </button>
        )}
      </div>

      <nav className="border-t border-border px-2 py-2" aria-label="Secondary">
        {proNav
          .filter((n) => !n.adminOnly || isAdmin)
          .map((n) =>
            has(n.feature) ? (
              <NavItem key={n.to} to={n.to} icon={n.icon} label={n.label} onNavigate={onNavigate} />
            ) : (
              <button
                key={n.to}
                type="button"
                onClick={() => openUpsell(n.feature)}
                className="nav-item w-full text-left"
              >
                <n.icon className="size-3.5 shrink-0" aria-hidden />
                <span className="flex-1 truncate">{n.label}</span>
                <LockIcon />
              </button>
            ),
          )}
        <NavItem to={routes.settings()} icon={Settings} label="Settings" onNavigate={onNavigate} />
      </nav>
    </aside>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return <div className="px-2 pt-2 pb-1 text-[10px] font-semibold tracking-wider text-fg-subtle uppercase">{children}</div>;
}

function NavItem({
  to,
  icon: Icon,
  label,
  end,
  className,
  onNavigate,
}: {
  to: string;
  icon: typeof Bell;
  label: string;
  end?: boolean;
  className?: string;
  onNavigate?: () => void;
}) {
  return (
    <NavLink to={to} end={end} className={({ isActive }) => cn("nav-item", isActive && "active", className)} onClick={onNavigate}>
      <Icon className="size-3.5 shrink-0" aria-hidden />
      <span className="flex-1 truncate">{label}</span>
    </NavLink>
  );
}

function useExpanded(key: string, defaultOpen = true) {
  const [open, setOpen] = useState<boolean>(() => {
    try {
      const v = localStorage.getItem(`bmv.sidebar.${key}`);
      return v == null ? defaultOpen : v === "1";
    } catch {
      return defaultOpen;
    }
  });
  const toggle = () =>
    setOpen((o) => {
      try {
        localStorage.setItem(`bmv.sidebar.${key}`, o ? "0" : "1");
      } catch {
        /* ignore */
      }
      return !o;
    });
  return [open, toggle] as const;
}

function ConnectionGroup({
  connection,
  queues,
  error,
  onNavigate,
}: {
  connection: RedisConnection;
  queues: QueueSummary[];
  error: unknown;
  onNavigate?: () => void;
}) {
  const params = useParams();
  const isCurrent = params.connectionId === connection.id;
  const [open, toggle] = useExpanded(`conn.${connection.id}`);
  const sorted = useMemo(() => [...queues].sort((a, b) => a.name.localeCompare(b.name)), [queues]);
  const failed = queues.reduce((s, q) => s + q.counts.failed, 0);

  return (
    <div className="mt-0.5">
      <div className={cn("group flex h-7 items-center gap-1 rounded-md pr-1 pl-1 hover:bg-surface-2", isCurrent && !params.queue && "bg-surface-3")}>
        <button type="button" onClick={toggle} aria-expanded={open} aria-label={open ? "Collapse" : "Expand"} className="rounded p-0.5 text-fg-subtle hover:text-fg">
          {open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
        </button>
        <NavLink to={routes.connection(connection.id)} onClick={onNavigate} className="flex min-w-0 flex-1 items-center gap-1.5 text-[13px] font-medium text-fg">
          <Database className="size-3.5 shrink-0 text-fg-subtle" aria-hidden />
          <span className="truncate">{connection.name}</span>
        </NavLink>
        {failed > 0 && !open && (
          <span className="num text-[10px] text-danger" title={`${failed} failed`}>
            {formatCompact(failed)}
          </span>
        )}
        <ConnectionStatusDot status={connection.status} pulse />
      </div>
      {open && (
        <ul className="ml-3 border-l border-border pl-1">
          {!!error && <li className="px-2 py-1 text-xs text-danger">Could not load queues</li>}
          {!error && sorted.length === 0 && <li className="px-2 py-1 text-xs text-fg-subtle">No queues discovered</li>}
          {sorted.map((q) => (
            <QueueRow key={q.name} connectionId={connection.id} queue={q} onNavigate={onNavigate} />
          ))}
        </ul>
      )}
    </div>
  );
}

function QueueRow({ connectionId, queue, onNavigate, hint }: { connectionId: string; queue: QueueSummary; onNavigate?: () => void; hint?: string }) {
  const params = useParams();
  const active = params.connectionId === connectionId && params.queue === queue.name;
  return (
    <li>
      <NavLink
        to={routes.queue(connectionId, queue.name)}
        onClick={onNavigate}
        className={cn("nav-item h-6.5 pr-1.5 pl-2 text-xs", active && "active")}
        title={hint ? `${hint} / ${queue.name}` : queue.name}
      >
        <span className="min-w-0 flex-1 truncate">
          {queue.name}
          {hint && <span className="ml-1 text-fg-subtle">· {hint}</span>}
        </span>
        {queue.isPaused && <span className="rounded bg-surface-3 px-1 text-[9px] text-fg-subtle uppercase">paused</span>}
        <span className="num text-[10px] text-fg-subtle" title="waiting">
          {formatCompact(queue.counts.waiting + queue.counts.prioritized)}
        </span>
        {queue.counts.failed > 0 && (
          <Tooltip content={`${formatCompact(queue.counts.failed)} failed`}>
            <span className="flex items-center gap-1 text-[10px] text-danger">
              <span className="status-dot size-1.5 bg-danger" />
              <span className="num">{formatCompact(queue.counts.failed)}</span>
            </span>
          </Tooltip>
        )}
      </NavLink>
    </li>
  );
}

function FolderTree({
  folders,
  byConnection,
  onNavigate,
}: {
  folders: FolderModel[];
  byConnection: { connection: RedisConnection; queues: QueueSummary[] }[];
  onNavigate?: () => void;
}) {
  const roots = folders.filter((f) => !f.parentId).sort((a, b) => a.position - b.position || a.name.localeCompare(b.name));
  const childrenOf = (id: string) =>
    folders.filter((f) => f.parentId === id).sort((a, b) => a.position - b.position || a.name.localeCompare(b.name));
  const lookup = (connectionId: string, queueName: string) => {
    const c = byConnection.find((b) => b.connection.id === connectionId);
    const q = c?.queues.find((qq) => qq.name === queueName);
    return c && q ? { connection: c.connection, queue: q } : null;
  };
  return (
    <div className="mb-2">
      {roots.map((f) => (
        <FolderNode key={f.id} folder={f} children={childrenOf(f.id)} lookup={lookup} onNavigate={onNavigate} depth={0} />
      ))}
    </div>
  );
}

function FolderNode({
  folder,
  children,
  lookup,
  onNavigate,
  depth,
}: {
  folder: FolderModel;
  children: FolderModel[];
  lookup: (cid: string, q: string) => { connection: RedisConnection; queue: QueueSummary } | null;
  onNavigate?: () => void;
  depth: number;
}) {
  const [open, toggle] = useExpanded(`folder.${folder.id}`);
  const params = useParams();
  const isCurrent = params.folderId === folder.id;
  const resolved = folder.queues.map((r) => ({ ref: r, hit: lookup(r.connectionId, r.queueName) }));
  return (
    <div className="mt-0.5" style={{ marginLeft: depth * 12 }}>
      <div className={cn("group flex h-7 items-center gap-1 rounded-md pr-1 pl-1 hover:bg-surface-2", isCurrent && "bg-surface-3")}>
        <button type="button" onClick={toggle} aria-expanded={open} aria-label={open ? "Collapse" : "Expand"} className="rounded p-0.5 text-fg-subtle hover:text-fg">
          {open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
        </button>
        <NavLink
          to={routes.folder(folder.id)}
          onClick={onNavigate}
          className={({ isActive }) => cn("flex min-w-0 flex-1 items-center gap-1.5 text-[13px] font-medium", isActive ? "text-fg" : "text-fg hover:underline")}
          title={`Open ${folder.name}`}
        >
          <Folder className="size-3.5 shrink-0" style={{ color: folder.color ?? "var(--fg-subtle)" }} aria-hidden />
          <span className="truncate">{folder.name}</span>
        </NavLink>
        <span className="num text-[10px] text-fg-subtle">{folder.queues.length}</span>
      </div>
      {open && (
        <>
          {children.map((c) => (
            <FolderNode key={c.id} folder={c} children={[]} lookup={lookup} onNavigate={onNavigate} depth={depth + 1} />
          ))}
          <ul className="ml-3 border-l border-border pl-1">
            {resolved.length === 0 && children.length === 0 && <li className="px-2 py-1 text-xs text-fg-subtle">Empty folder</li>}
            {resolved.map(({ ref, hit }) =>
              hit ? (
                <QueueRow key={`${ref.connectionId}/${ref.queueName}`} connectionId={hit.connection.id} queue={hit.queue} hint={hit.connection.name} onNavigate={onNavigate} />
              ) : (
                <li key={`${ref.connectionId}/${ref.queueName}`} className="nav-item h-6.5 pl-2 text-xs text-fg-subtle line-through" title="Queue not found on its connection">
                  {ref.queueName}
                </li>
              ),
            )}
          </ul>
        </>
      )}
    </div>
  );
}
