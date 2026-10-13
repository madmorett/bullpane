import { useEffect, useMemo, useRef, useState } from "react";
import type { ProFeature } from "@bullpane/shared";
import { useNavigate } from "react-router-dom";
import {
  AlertTriangle,
  BarChart3,
  Bell,
  Bot,
  CalendarClock,
  CornerDownLeft,
  Database,
  Folder,
  HeartPulse,
  Info,
  KeyRound,
  LayoutDashboard,
  ListChecks,
  LogOut,
  Monitor,
  Moon,
  Palette,
  ScrollText,
  Search,
  Settings,
  ShieldCheck,
  Sun,
  User,
  Users,
  Workflow,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/cn";
import { routes } from "@/lib/routes";
import { queueLandingState } from "@/lib/queueLanding";
import { formatCompact } from "@/lib/format";
import { scoreCommand } from "@/lib/commandSearch";
import { setThemePref } from "@/lib/theme";
import { SHOW_FLOWS } from "@/lib/featureFlags";
import { queueRef, useSidebarLayout } from "@/lib/sidebarLayout";
import { useAlerts, useAllQueues, useFlowMaps, useFolders, useUsers } from "@/api/hooks";
import { useAuth } from "@/auth/AuthProvider";
import { useEdition } from "@/edition/useEdition";
import { openUpsell } from "@/edition/upsellStore";
import { LockIcon } from "@/edition/ProBadge";
import { Kbd } from "@/components/ui/Kbd";

type Kind = "Queue" | "Page" | "Settings" | "Action" | "Connection" | "Folder" | "Flow map" | "Alert rule" | "User";

interface Command {
  id: string;
  kind: Kind;
  title: string;
  hint?: string;
  keywords?: string;
  icon: LucideIcon;
  /** where it goes; or `run` for actions */
  to?: string;
  run?: () => void;
  /** Pro feature the viewer lacks: shown with a lock, opens the upsell */
  locked?: ProFeature;
  /** only offered once something is typed (a queue's tabs would drown the empty list) */
  deep?: boolean;
  /** queue rows: live counters on the right */
  counts?: { waiting: number; failed: number; paused: boolean };
}

/** Empty query: what you most likely want first. A typed query ranks by score, then by this. */
const KIND_ORDER: Kind[] = ["Queue", "Page", "Folder", "Connection", "Settings", "Action", "Flow map", "Alert rule", "User"];

/**
 * Cmd/Ctrl+K: search everything the dashboard has, client side — pages,
 * settings tabs, queues (and their tabs), connections, folders, flow maps,
 * alert rules, users, and a few actions. Everything comes from lists the app
 * already caches; the Pro and admin lists are fetched only while the palette
 * is open and only when the viewer can open them.
 */
export function QuickSwitcher({ open, onClose }: { open: boolean; onClose: () => void }) {
  const commands = useCommands(open);
  const navigate = useNavigate();
  const [q, setQ] = useState("");
  const [idx, setIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  const filtered = useMemo(() => {
    const typed = q.trim() !== "";
    return commands
      .filter((c) => typed || !c.deep)
      // A queue's tabs rank just below the queue itself and never on a fuzzy
      // subsequence: "sso" must not list every queue's "› Search jobs".
      .map((c) => {
        const score = scoreCommand(q, c);
        return { c, score: c.deep ? (score >= 30 ? score - 5 : 0) : score };
      })
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score || KIND_ORDER.indexOf(a.c.kind) - KIND_ORDER.indexOf(b.c.kind))
      .slice(0, 60)
      .map((s) => s.c);
  }, [commands, q]);

  useEffect(() => {
    const d = dialogRef.current;
    if (!d) return;
    if (open && !d.open) {
      d.showModal();
      setQ("");
      setIdx(0);
      setTimeout(() => inputRef.current?.focus(), 0);
    } else if (!open && d.open) d.close();
  }, [open]);

  useEffect(() => {
    setIdx(0);
  }, [q]);

  useEffect(() => {
    const el = listRef.current?.children[idx] as HTMLElement | undefined;
    el?.scrollIntoView({ block: "nearest" });
  }, [idx]);

  const go = (c: Command | undefined) => {
    if (!c) return;
    onClose();
    if (c.locked) openUpsell(c.locked);
    else if (c.run) c.run();
    else if (c.to) navigate(c.to);
  };

  return (
    <dialog
      ref={dialogRef}
      className="dialog !mt-[12vh]"
      style={{ ["--dialog-w" as string]: "40rem" }}
      aria-label="Search"
      onClose={onClose}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => e.target === dialogRef.current && onClose()}
    >
      {open && (
        <div onClick={(e) => e.stopPropagation()}>
          <div className="flex items-center gap-2 border-b border-border px-3">
            <Search className="size-4 text-fg-subtle" aria-hidden />
            <input
              ref={inputRef}
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search queues, pages, settings, folders…"
              aria-label="Search"
              aria-activedescendant={filtered[idx] ? `qs-${filtered[idx].id}` : undefined}
              role="combobox"
              aria-expanded
              aria-controls="qs-list"
              className="h-11 flex-1 bg-transparent text-sm text-fg outline-none placeholder:text-fg-subtle"
              onKeyDown={(e) => {
                if (e.key === "ArrowDown") {
                  e.preventDefault();
                  setIdx((i) => Math.min(filtered.length - 1, i + 1));
                } else if (e.key === "ArrowUp") {
                  e.preventDefault();
                  setIdx((i) => Math.max(0, i - 1));
                } else if (e.key === "Enter") {
                  e.preventDefault();
                  go(filtered[idx]);
                }
              }}
            />
            <Kbd>esc</Kbd>
          </div>
          <ul id="qs-list" ref={listRef} role="listbox" className="max-h-[55vh] overflow-y-auto p-1">
            {filtered.length === 0 && <li className="px-3 py-8 text-center text-xs text-fg-subtle">Nothing matches “{q.trim()}”</li>}
            {filtered.map((c, i) => (
              <li
                key={c.id}
                id={`qs-${c.id}`}
                role="option"
                aria-selected={i === idx}
                onMouseEnter={() => setIdx(i)}
                onClick={() => go(c)}
                className={cn("flex cursor-pointer items-center gap-2 rounded-md px-2.5 py-1.5 text-[13px]", i === idx ? "bg-surface-3 text-fg" : "text-fg-muted")}
              >
                <c.icon className="size-3.5 shrink-0 text-fg-subtle" aria-hidden />
                <span className="truncate font-medium text-fg">
                  <Highlight text={c.title} needle={q} />
                </span>
                {c.hint && <span className="truncate text-xs text-fg-subtle">{c.hint}</span>}
                {c.locked && <LockIcon />}
                <span className="ml-auto flex shrink-0 items-center gap-2">
                  {c.counts?.paused && <span className="rounded bg-surface-3 px-1 text-[9px] uppercase">paused</span>}
                  {c.counts && <span className="num text-xs text-fg-subtle">{formatCompact(c.counts.waiting)} waiting</span>}
                  {c.counts && c.counts.failed > 0 && <span className="num text-xs text-danger">{formatCompact(c.counts.failed)} failed</span>}
                  <span className="w-16 text-right text-[10px] tracking-wide text-fg-subtle uppercase">{c.kind}</span>
                  <CornerDownLeft className={cn("size-3.5 text-fg-subtle", i !== idx && "invisible")} aria-hidden />
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </dialog>
  );
}

function useCommands(open: boolean): Command[] {
  const { byConnection } = useAllQueues();
  const { isAdmin, isAnonymous, logout } = useAuth();
  const { has } = useEdition();
  const { layout } = useSidebarLayout();
  const navigate = useNavigate();
  const folders = useFolders(has("folders"));
  const alerts = useAlerts(open && has("alerts"));
  const users = useUsers(open && has("users") && isAdmin);
  const flowMaps = useFlowMaps(open && SHOW_FLOWS && has("flows"));

  return useMemo(() => {
    const out: Command[] = [];
    const lock = (f: ProFeature) => (has(f) ? undefined : f);

    // Pages: the same set and the same rules as the sidebar (admin-only stay admin-only, Pro ones show locked).
    out.push(
      { id: "page:overview", kind: "Page", title: "Overview", keywords: "home dashboard queues", icon: LayoutDashboard, to: routes.home },
      { id: "page:schedulers", kind: "Page", title: "Schedulers", keywords: "repeatable cron job schedulers", icon: CalendarClock, to: routes.schedulers() },
      { id: "page:health", kind: "Page", title: "Health", keywords: "redis memory cpu latency server monitor", icon: HeartPulse, to: routes.health },
      { id: "page:alerts", kind: "Page", title: "Alerts", keywords: "rules notifications slack webhook email", icon: Bell, to: routes.alerts, locked: lock("alerts") },
      { id: "page:folders", kind: "Page", title: "Folders", keywords: "manage folders groups organize", icon: Folder, to: routes.folders, locked: lock("folders") },
      { id: "page:settings", kind: "Page", title: "Settings", keywords: "preferences configuration", icon: Settings, to: routes.settings() },
    );
    if (SHOW_FLOWS) out.push({ id: "page:flows", kind: "Page", title: "Flows", keywords: "flow maps graph parent child", icon: Workflow, to: routes.flows(), locked: lock("flows") });
    if (isAdmin) {
      out.push(
        { id: "page:users", kind: "Page", title: "Users", keywords: "roles team members accounts invite", icon: Users, to: routes.users, locked: lock("users") },
        { id: "page:audit", kind: "Page", title: "Audit log", keywords: "history who did what actions trail", icon: ScrollText, to: routes.audit(), locked: lock("audit") },
      );
    }

    out.push(
      { id: "settings:connections", kind: "Settings", title: "Connections", hint: "Settings", keywords: "redis postgres add connection url prefix", icon: Database, to: routes.settings("connections") },
      { id: "settings:attention", kind: "Settings", title: "Attention thresholds", hint: "Settings", keywords: "needs attention failed rate thresholds", icon: AlertTriangle, to: routes.settings("attention") },
      { id: "settings:sso", kind: "Settings", title: "SSO", hint: "Settings", keywords: "single sign-on oidc saml google okta login", icon: ShieldCheck, to: routes.settings("sso"), locked: lock("sso") },
      { id: "settings:mcp", kind: "Settings", title: "MCP", hint: "Settings", keywords: "ai agent claude model context protocol", icon: Bot, to: routes.settings("mcp"), locked: lock("mcp") },
      { id: "settings:license", kind: "Settings", title: "License", hint: "Settings", keywords: "pro key subscription billing upgrade", icon: KeyRound, to: routes.settings("license") },
      { id: "settings:appearance", kind: "Settings", title: "Appearance", hint: "Settings", keywords: "theme dark light mode", icon: Palette, to: routes.settings("appearance") },
      { id: "settings:about", kind: "Settings", title: "About", hint: "Settings", keywords: "version uptime", icon: Info, to: routes.settings("about") },
    );

    out.push(
      { id: "action:theme-light", kind: "Action", title: "Theme: Light", keywords: "appearance mode", icon: Sun, run: () => setThemePref("light") },
      { id: "action:theme-dark", kind: "Action", title: "Theme: Dark", keywords: "appearance mode", icon: Moon, run: () => setThemePref("dark") },
      { id: "action:theme-system", kind: "Action", title: "Theme: System", keywords: "appearance mode os auto", icon: Monitor, run: () => setThemePref("system") },
    );
    if (!isAnonymous) out.push({ id: "action:logout", kind: "Action", title: "Log out", keywords: "sign out exit", icon: LogOut, run: () => void logout().then(() => navigate(routes.login)) });

    // Queues: pinned ones first on the empty list, like the sidebar and the Overview.
    const queues = byConnection.flatMap(({ connection, queues }) => queues.map((queue) => ({ connection, queue })));
    const pinRank = (ref: string) => {
      const i = layout.pinned.indexOf(ref);
      return i < 0 ? layout.pinned.length : i;
    };
    queues.sort((a, b) => pinRank(queueRef(a.connection.id, a.queue.name)) - pinRank(queueRef(b.connection.id, b.queue.name)) || a.queue.name.localeCompare(b.queue.name));
    for (const { connection, queue } of queues) {
      const ref = queueRef(connection.id, queue.name);
      const hint = connection.name;
      out.push({
        id: `queue:${ref}`,
        kind: "Queue",
        title: queue.name,
        hint,
        keywords: layout.pinned.includes(ref) ? "pinned" : undefined,
        icon: ListChecks,
        to: routes.queue(connection.id, queue.name, queueLandingState(queue.counts)),
        counts: { waiting: queue.counts.waiting + queue.counts.prioritized, failed: queue.counts.failed, paused: queue.isPaused },
      });
      out.push(
        { id: `queue:${ref}:failed`, kind: "Queue", title: `${queue.name} › Failed jobs`, hint, keywords: "errors", icon: AlertTriangle, to: routes.queue(connection.id, queue.name, "failed"), deep: true },
        { id: `queue:${ref}:search`, kind: "Queue", title: `${queue.name} › Search jobs`, hint, keywords: "find job id data payload", icon: Search, to: routes.queueSearch(connection.id, queue.name), deep: true },
        { id: `queue:${ref}:metrics`, kind: "Queue", title: `${queue.name} › Metrics`, hint, keywords: "charts throughput graphs", icon: BarChart3, to: routes.queueMetrics(connection.id, queue.name), deep: true },
        { id: `queue:${ref}:schedulers`, kind: "Queue", title: `${queue.name} › Schedulers`, hint, keywords: "repeatable cron", icon: CalendarClock, to: routes.queueSchedulers(connection.id, queue.name), deep: true },
      );
      if (queue.isPro) out.push({ id: `queue:${ref}:groups`, kind: "Queue", title: `${queue.name} › Groups`, hint, keywords: "bullmq pro groups", icon: Users, to: routes.groups(connection.id, queue.name), deep: true });
    }

    for (const { connection, queues } of byConnection) {
      out.push(
        { id: `conn:${connection.id}`, kind: "Connection", title: connection.name, hint: `${queues.length} queues`, keywords: `redis postgres ${connection.kind ?? ""}`, icon: Database, to: routes.connection(connection.id) },
        { id: `conn:${connection.id}:schedulers`, kind: "Connection", title: `${connection.name} › Schedulers`, keywords: "repeatable cron", icon: CalendarClock, to: routes.schedulers(connection.id), deep: true },
      );
    }

    for (const f of folders.data ?? []) {
      const parent = f.parentId ? folders.data?.find((p) => p.id === f.parentId)?.name : undefined;
      out.push({ id: `folder:${f.id}`, kind: "Folder", title: f.name, hint: parent ? `in ${parent}` : `${f.queues.length} queues`, icon: Folder, to: routes.folder(f.id) });
    }
    for (const m of flowMaps.data?.maps ?? []) out.push({ id: `map:${m.id}`, kind: "Flow map", title: m.name, hint: m.description ?? undefined, icon: Workflow, to: routes.flowMap(m.id) });
    for (const a of alerts.data ?? []) out.push({ id: `alert:${a.id}`, kind: "Alert rule", title: a.name, hint: a.firing ? "firing" : a.enabled ? undefined : "disabled", icon: Bell, to: routes.alerts });
    for (const u of users.data ?? []) out.push({ id: `user:${u.id}`, kind: "User", title: u.name || u.email, hint: u.email, keywords: u.role, icon: User, to: routes.users });

    return out;
  }, [byConnection, folders.data, flowMaps.data, alerts.data, users.data, layout.pinned, has, isAdmin, isAnonymous, logout, navigate]);
}

function Highlight({ text, needle }: { text: string; needle: string }) {
  const n = needle.trim().toLowerCase();
  if (!n) return <>{text}</>;
  const i = text.toLowerCase().indexOf(n);
  if (i < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, i)}
      <mark className="rounded-sm bg-accent/25 text-fg">{text.slice(i, i + n.length)}</mark>
      {text.slice(i + n.length)}
    </>
  );
}
