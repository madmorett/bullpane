import { useEffect, useMemo } from "react";
import { NavLink, useParams } from "react-router-dom";
import {
  Bell,
  ChevronDown,
  ChevronRight,
  Database,
  Folder,
  FolderLock,
  LayoutDashboard,
  CalendarClock,
  Pin,
  PinOff,
  ScrollText,
  Search,
  Settings,
  Users,
  Workflow,
} from "lucide-react";
import type { Folder as FolderModel, ProFeature, QueueSummary, RedisConnection } from "@bullpane/shared";
import { cn } from "@/lib/cn";
import { routes } from "@/lib/routes";
import { queueLandingState } from "@/lib/queueLanding";
import { SHOW_FLOWS } from "@/lib/featureFlags";
import { formatCompact } from "@/lib/format";
import { usePersistedToggle } from "@/lib/usePersistedToggle";
import { applyOrder, folderRef, queueRef, useSidebarLayout, type SidebarLayout } from "@/lib/sidebarLayout";
import { SortableList, useSortableRow } from "./SortableList";
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
  const { layout, move } = useLayout();
  const foldersEnabled = has("folders");
  const folders = useFolders(foldersEnabled);
  const folderList = foldersEnabled ? (folders.data ?? []) : [];
  const lookup = lookupIn(byConnection);
  // Root folders and connections are one list, so a connection can be dragged
  // above a folder. Default: folders (admin order) first, then connections.
  const tree = applyOrder(
    [
      ...folderChildren(folderList, null, layout.order).map((folder) => ({ id: folderRef(folder.id), folder, conn: null })),
      ...byConnection.map((conn) => ({ id: `conn:${conn.connection.id}`, folder: null, conn })),
    ],
    (item) => item.id,
    layout.order.tree,
  );
  const treeIds = tree.map((item) => item.id);
  const pinned = new Set(layout.pinned);
  const shownTree = tree.filter((item) => !pinned.has(item.id));

  const proNav: { to: string; label: string; icon: typeof Bell; feature: ProFeature; adminOnly?: boolean }[] = [
    { to: routes.alerts, label: "Alerts", icon: Bell, feature: "alerts" },
    ...(SHOW_FLOWS ? [{ to: routes.flows(), label: "Flows", icon: Workflow, feature: "flows" as ProFeature }] : []),
    { to: routes.users, label: "Users", icon: Users, feature: "users", adminOnly: true },
    // Audit is admin-only: the trail shows actions only an admin performs
    // (connections, users, license), so reading it is a different right from pausing a queue.
    { to: routes.audit(), label: "Audit log", icon: ScrollText, feature: "audit", adminOnly: true },
  ];

  return (
    <aside className={cn("flex h-full w-64 shrink-0 flex-col border-r border-border bg-surface", className)} aria-label="Sidebar">
      <div className="flex h-12 items-center gap-2 border-b border-border px-3">
        <Logo />
        <span className="truncate text-[13px] font-semibold tracking-tight">Bullpane</span>
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
        {/* Schedulers live outside the 8 job states, so without a top-level entry
            the only way to find them is to open every queue's tab in turn. */}
        <NavItem to={routes.schedulers()} icon={CalendarClock} label="Schedulers" onNavigate={onNavigate} />
      </nav>

      <div className="mt-2 min-h-0 flex-1 overflow-x-hidden overflow-y-auto px-2 pb-2">
        <Pinned byConnection={byConnection} folders={folderList} onNavigate={onNavigate} />

        <SectionLabel>Queues</SectionLabel>

        <SortableList ids={shownTree.map((item) => item.id)} onMove={(d, t) => move("tree", treeIds, d, t)}>
          {shownTree.map(({ id, folder, conn }) =>
            folder ? (
              <FolderNode key={id} sortId={id} folder={folder} folders={folderList} lookup={lookup} onNavigate={onNavigate} depth={0} />
            ) : (
              conn && (
                <ConnectionGroup
                  key={id}
                  sortId={id}
                  connection={conn.connection}
                  queues={conn.queues}
                  error={conn.error}
                  onNavigate={onNavigate}
                  defaultOpen={byConnection.length <= SIDEBAR_COLLAPSE_ABOVE}
                />
              )
            ),
          )}
        </SortableList>

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

/** Personal sidebar layout (pins and drag order) of whoever is signed in. */
function useLayout() {
  const { user } = useAuth();
  return useSidebarLayout(user?.id);
}

/** The row being dragged floats above its siblings. */
const DRAGGING = "data-[dragging]:bg-surface-2 data-[dragging]:shadow-[var(--shadow)]";

type Lookup = (connectionId: string, queueName: string) => { connection: RedisConnection; queue: QueueSummary } | null;

function lookupIn(byConnection: { connection: RedisConnection; queues: QueueSummary[] }[]): Lookup {
  return (connectionId, queueName) => {
    const c = byConnection.find((b) => b.connection.id === connectionId);
    const q = c?.queues.find((qq) => qq.name === queueName);
    return c && q ? { connection: c.connection, queue: q } : null;
  };
}

/**
 * A folder's subfolders (or the roots): the admin's order (`position`), then
 * each user's drag order on top. The roots' drag order lives in the sidebar
 * tree, mixed with connections.
 */
function folderChildren(folders: FolderModel[], parentId: string | null, order: SidebarLayout["order"]): FolderModel[] {
  return applyOrder(
    folders.filter((f) => (f.parentId ?? null) === parentId).sort((a, b) => a.position - b.position || a.name.localeCompare(b.name)),
    (f) => f.id,
    parentId ? order[`folders.${parentId}`] : undefined,
  );
}

function Pinned({
  byConnection,
  folders,
  onNavigate,
}: {
  byConnection: { connection: RedisConnection; queues: QueueSummary[] }[];
  folders: FolderModel[];
  onNavigate?: () => void;
}) {
  const { layout, move } = useLayout();
  const lookup = lookupIn(byConnection);
  // ponytail: a pin whose queue or folder is gone (or not loaded yet, or folders
  // are locked) is just not shown; it comes back if the target does.
  type Item = { ref: string; folder: FolderModel | null; hit: ReturnType<Lookup> };
  const items = layout.pinned.flatMap((ref): Item[] => {
    const folder = folders.find((f) => folderRef(f.id) === ref);
    if (folder) return [{ ref, folder, hit: null }];
    const slash = ref.indexOf("/");
    const hit = slash > 0 ? lookup(ref.slice(0, slash), ref.slice(slash + 1)) : null;
    return hit ? [{ ref, folder: null, hit }] : [];
  });
  if (items.length === 0) return null;
  return (
    <div className="mb-2">
      <SectionLabel>Pinned</SectionLabel>
      {/* Moves within the full pinned list, so hidden pins keep their place.
          Every other list leaves out what is pinned here (one place per item)
          but also moves within its full list, so an unpinned item returns
          to where it was. */}
      <SortableList ids={items.map((i) => i.ref)} onMove={(d, t) => move("pinned", layout.pinned, d, t)}>
        <ul>
          {items.map(({ ref, folder, hit }) =>
            folder ? (
              <li key={ref}>
                <FolderNode sortId={ref} folder={folder} folders={folders} lookup={lookup} onNavigate={onNavigate} depth={0} />
              </li>
            ) : (
              hit && (
                <QueueRow
                  key={ref}
                  sortId={ref}
                  connectionId={hit.connection.id}
                  queue={hit.queue}
                  hint={byConnection.length > 1 ? hit.connection.name : undefined}
                  onNavigate={onNavigate}
                />
              )
            ),
          )}
        </ul>
      </SortableList>
    </div>
  );
}

/** Pin or unpin a queue or folder. Zero width until its row (`group/pin`) is hovered or it is focused. */
function PinButton({ pinRef, label }: { pinRef: string; label: string }) {
  const { layout, togglePin } = useLayout();
  const pinned = layout.pinned.includes(pinRef);
  return (
    <button
      type="button"
      onClick={() => togglePin(pinRef)}
      aria-label={pinned ? `Unpin ${label}` : `Pin ${label}`}
      title={pinned ? "Unpin" : "Pin to top"}
      className="flex h-6 w-0 shrink-0 items-center justify-center overflow-hidden rounded text-fg-subtle opacity-0 group-hover/pin:w-5 group-hover/pin:opacity-100 hover:text-fg focus-visible:w-5 focus-visible:opacity-100"
    >
      {pinned ? <PinOff className="size-3" /> : <Pin className="size-3" />}
    </button>
  );
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

/**
 * Sidebar disclosure state, persisted under `bullpane.sidebar.<key>`.
 * The key namespace is unchanged, so choices made before this refactor survive.
 */
function useExpanded(key: string, defaultOpen = true) {
  const [open, toggle, set] = usePersistedToggle(`sidebar.${key}`, defaultOpen);
  return [open, toggle, set] as const;
}

/**
 * Above this many connections the sidebar stops expanding every connection.
 * With ten connections and 81 queues the fully expanded tree is an endless
 * list; collapsed, it is ten rows with counters and you expand the one you want.
 */
const SIDEBAR_COLLAPSE_ABOVE = 3;

function ConnectionGroup({
  connection,
  queues,
  error,
  onNavigate,
  defaultOpen,
  sortId,
}: {
  connection: RedisConnection;
  queues: QueueSummary[];
  error: unknown;
  onNavigate?: () => void;
  defaultOpen: boolean;
  /** id in the surrounding SortableList */
  sortId: string;
}) {
  const row = useSortableRow(sortId);
  const params = useParams();
  const isCurrent = params.connectionId === connection.id;
  const [open, toggle, setOpen] = useExpanded(`conn.${connection.id}`, defaultOpen);
  const { layout, move } = useLayout();
  const list = `conn.${connection.id}`;
  const byName = useMemo(() => [...queues].sort((a, b) => a.name.localeCompare(b.name)), [queues]);
  const sorted = applyOrder(byName, (q) => q.name, layout.order[list]);
  const names = sorted.map((q) => q.name);
  const shown = sorted.filter((q) => !layout.pinned.includes(queueRef(connection.id, q.name)));
  const failed = queues.reduce((s, q) => s + q.counts.failed, 0);
  const waiting = queues.reduce((s, q) => s + q.counts.waiting + q.counts.prioritized, 0);

  // The connection you are looking at is always expanded, so the tree never
  // hides the page you are on. Collapsing it by hand still works — this only
  // fires when the route changes to a different connection.
  useEffect(() => {
    if (isCurrent && !open) setOpen(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isCurrent, connection.id]);

  return (
    <div {...row.node} className={cn("mt-0.5 rounded-md", DRAGGING)}>
      <div {...row.handle} className={cn("group flex h-7 items-center gap-1 rounded-md pr-1 pl-1 hover:bg-surface-2", isCurrent && !params.queue && "bg-surface-3")}>
        <button type="button" onClick={toggle} aria-expanded={open} aria-label={open ? "Collapse" : "Expand"} className="rounded p-0.5 text-fg-subtle hover:text-fg">
          {open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
        </button>
        <NavLink to={routes.connection(connection.id)} onClick={onNavigate} className="flex min-w-0 flex-1 items-center gap-1.5 text-[13px] font-medium text-fg">
          <Database className="size-3.5 shrink-0 text-fg-subtle" aria-hidden />
          <span className="truncate">{connection.name}</span>
        </NavLink>
        {/*
          Collapsed, only `failed` gets its own number. Queue count and waiting
          live in the tooltip: three counters in a 256px rail truncated the
          connection name down to "redis-mone…", and the name is what you
          navigate by.
        */}
        {!open && (
          <Tooltip content={`${queues.length} ${queues.length === 1 ? "queue" : "queues"} · ${formatCompact(waiting)} waiting · ${formatCompact(failed)} failed`}>
            <span className="flex shrink-0 cursor-help items-center gap-1">
              <span className="num text-[10px] text-fg-subtle">{queues.length}</span>
              {failed > 0 && <span className="num text-[10px] text-danger">{formatCompact(failed)}</span>}
            </span>
          </Tooltip>
        )}
        <ConnectionStatusDot status={connection.status} pulse />
      </div>
      {open && (
        <SortableList ids={shown.map((q) => q.name)} onMove={(d, t) => move(list, names, d, t)}>
          <ul className="ml-3 border-l border-border pl-1">
            {!!error && <li className="px-2 py-1 text-xs text-danger">Could not load queues</li>}
            {!error && queues.length === 0 && <li className="px-2 py-1 text-xs text-fg-subtle">No queues discovered</li>}
            {shown.map((q) => (
              <QueueRow key={q.name} sortId={q.name} connectionId={connection.id} queue={q} onNavigate={onNavigate} />
            ))}
          </ul>
        </SortableList>
      )}
    </div>
  );
}

function QueueRow({
  connectionId,
  queue,
  onNavigate,
  hint,
  sortId,
}: {
  connectionId: string;
  queue: QueueSummary;
  onNavigate?: () => void;
  hint?: string;
  /** id in the surrounding SortableList */
  sortId: string;
}) {
  const params = useParams();
  const row = useSortableRow(sortId);
  const active = params.connectionId === connectionId && params.queue === queue.name;
  return (
    <li {...row.node} {...row.handle} className={cn("group/pin flex items-center rounded-md", DRAGGING)}>
      <NavLink
        // Same rule as the card and the table: the click lands on the state that
        // matters (failed → waiting → completed), not on the default `waiting`. See
        // lib/queueLanding.ts.
        to={routes.queue(connectionId, queue.name, queueLandingState(queue.counts))}
        onClick={onNavigate}
        className={cn("nav-item h-6.5 flex-1 pr-1.5 pl-2 text-xs", active && "active")}
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
        {/* The failed pill must NOT become an <a>: we are already inside a
            NavLink and a link inside a link is invalid HTML. No loss — when there
            are failures, the row itself already goes to `failed` (queueLandingState). */}
        {queue.counts.failed > 0 && (
          <Tooltip content={`${formatCompact(queue.counts.failed)} failed · click to open them`}>
            <span className="flex items-center gap-1 text-[10px] text-danger">
              <span className="status-dot size-1.5 bg-danger" />
              <span className="num">{formatCompact(queue.counts.failed)}</span>
            </span>
          </Tooltip>
        )}
      </NavLink>
      {/* A sibling of the link, not inside it: a button inside an <a> is invalid HTML. */}
      <PinButton pinRef={queueRef(connectionId, queue.name)} label={queue.name} />
    </li>
  );
}

function FolderNode({
  folder,
  folders,
  lookup,
  onNavigate,
  depth,
  sortId,
}: {
  folder: FolderModel;
  folders: FolderModel[];
  lookup: Lookup;
  onNavigate?: () => void;
  depth: number;
  /** id in the surrounding SortableList */
  sortId: string;
}) {
  const [open, toggle] = useExpanded(`folder.${folder.id}`);
  const params = useParams();
  const row = useSortableRow(sortId);
  const { layout, move } = useLayout();
  const isCurrent = params.folderId === folder.id;
  // Two levels, as before: a subfolder does not list its own subfolders.
  const children = depth === 0 ? folderChildren(folders, folder.id, layout.order) : [];
  const childIds = children.map((c) => c.id);
  const shownChildren = children.filter((c) => !layout.pinned.includes(folderRef(c.id)));
  const queueList = `folder.${folder.id}`;
  const resolved = applyOrder(
    folder.queues.map((r) => ({ ref: r, key: queueRef(r.connectionId, r.queueName), hit: lookup(r.connectionId, r.queueName) })),
    (r) => r.key,
    layout.order[queueList],
  );
  const queueKeys = resolved.map((r) => r.key);
  const shownQueues = resolved.filter((r) => !layout.pinned.includes(r.key));
  return (
    <div {...row.node} className={cn("mt-0.5 rounded-md", DRAGGING)} style={{ ...row.node.style, marginLeft: depth * 12 }}>
      <div {...row.handle} className={cn("group/pin flex h-7 items-center gap-1 rounded-md pr-1 pl-1 hover:bg-surface-2", isCurrent && "bg-surface-3")}>
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
        <PinButton pinRef={folderRef(folder.id)} label={folder.name} />
      </div>
      {open && (
        <>
          <SortableList ids={shownChildren.map((c) => c.id)} onMove={(d, t) => move(`folders.${folder.id}`, childIds, d, t)}>
            {shownChildren.map((c) => (
              <FolderNode key={c.id} sortId={c.id} folder={c} folders={folders} lookup={lookup} onNavigate={onNavigate} depth={depth + 1} />
            ))}
          </SortableList>
          <SortableList ids={shownQueues.map((r) => r.key)} onMove={(d, t) => move(queueList, queueKeys, d, t)}>
            <ul className="ml-3 border-l border-border pl-1">
              {resolved.length === 0 && children.length === 0 && <li className="px-2 py-1 text-xs text-fg-subtle">Empty folder</li>}
              {shownQueues.map(({ ref, key, hit }) =>
                hit ? (
                  <QueueRow key={key} sortId={key} connectionId={hit.connection.id} queue={hit.queue} hint={hit.connection.name} onNavigate={onNavigate} />
                ) : (
                  <li key={key} className="nav-item h-6.5 pl-2 text-xs text-fg-subtle line-through" title="Queue not found on its connection">
                    {ref.queueName}
                  </li>
                ),
              )}
            </ul>
          </SortableList>
        </>
      )}
    </div>
  );
}
