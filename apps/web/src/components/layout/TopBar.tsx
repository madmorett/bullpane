import { useEffect, useRef, useState } from "react";
import { Link, useLocation, useParams } from "react-router-dom";
import { ChevronRight, KeyRound, LogOut, Menu, Search, ScrollText, Shield } from "lucide-react";
import { cn } from "@/lib/cn";
import { routes } from "@/lib/routes";
import { modKeyLabel } from "@/lib/useHotkey";
import { useConnections } from "@/api/hooks";
import { useAuth } from "@/auth/AuthProvider";
import { Button } from "@/components/ui/Button";
import { Kbd } from "@/components/ui/Kbd";
import { Badge } from "@/components/ui/Badge";
import { ConnectionStatusDot } from "@/components/ConnectionStatusDot";
import { HealthTopBarSummary } from "@/components/health/HealthTopBarSummary";
import { useEdition } from "@/edition/useEdition";

interface Crumb {
  label: string;
  to?: string;
  mono?: boolean;
}

function useCrumbs(): Crumb[] {
  const params = useParams<{ connectionId?: string; queue?: string; jobId?: string; groupId?: string; tab?: string }>();
  const { pathname } = useLocation();
  const connections = useConnections();
  const conn = connections.data?.find((c) => c.id === params.connectionId);

  const crumbs: Crumb[] = [{ label: "Overview", to: routes.home }];
  if (pathname.startsWith("/settings")) {
    crumbs.push({ label: "Settings", to: routes.settings() });
    if (params.tab) crumbs.push({ label: params.tab[0].toUpperCase() + params.tab.slice(1) });
    return crumbs;
  }
  if (pathname.startsWith("/health")) return [...crumbs, { label: "Redis health" }];
  if (pathname.startsWith("/alerts")) return [...crumbs, { label: "Alerts" }];
  if (pathname.startsWith("/users")) return [...crumbs, { label: "Users" }];
  if (pathname.startsWith("/audit")) return [...crumbs, { label: "Audit log" }];
  if (pathname.startsWith("/folders")) return [...crumbs, { label: "Folders" }];
  if (pathname.startsWith("/flows")) {
    crumbs.push({ label: "Flows", to: routes.flows() });
    if (conn) crumbs.push({ label: conn.name });
    return crumbs;
  }
  if (params.connectionId) {
    crumbs.push({ label: conn?.name ?? params.connectionId, to: routes.connection(params.connectionId) });
    if (params.queue) {
      crumbs.push({ label: params.queue, to: routes.queue(params.connectionId, params.queue) });
      if (pathname.includes("/groups")) {
        crumbs.push({ label: "Groups", to: params.groupId ? routes.groups(params.connectionId, params.queue) : undefined });
        if (params.groupId) crumbs.push({ label: params.groupId, mono: true });
      }
      if (params.jobId) crumbs.push({ label: params.jobId, mono: true });
    }
  }
  return crumbs;
}

export function TopBar({ onOpenSwitcher, onToggleSidebar }: { onOpenSwitcher: () => void; onToggleSidebar: () => void }) {
  const crumbs = useCrumbs();
  const params = useParams<{ connectionId?: string }>();
  const connections = useConnections();
  const conn = connections.data?.find((c) => c.id === params.connectionId);

  return (
    <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border bg-surface px-3">
      <Button variant="ghost" size="icon-sm" className="lg:hidden" aria-label="Toggle sidebar" onClick={onToggleSidebar}>
        <Menu />
      </Button>
      <nav aria-label="Breadcrumb" className="min-w-0 flex-1">
        <ol className="flex min-w-0 items-center gap-1 text-[13px]">
          {crumbs.map((c, i) => {
            const last = i === crumbs.length - 1;
            return (
              <li key={i} className={cn("flex min-w-0 items-center gap-1", last && "min-w-0 flex-1")}>
                {i > 0 && <ChevronRight className="size-3.5 shrink-0 text-fg-subtle" aria-hidden />}
                {c.to && !last ? (
                  <Link to={c.to} className="truncate text-fg-muted hover:text-fg">
                    {c.label}
                  </Link>
                ) : (
                  <span aria-current={last ? "page" : undefined} className={cn("truncate", last ? "font-medium text-fg" : "text-fg-muted", c.mono && "font-mono text-xs")}>
                    {c.label}
                  </span>
                )}
              </li>
            );
          })}
        </ol>
      </nav>
      {conn && (
        <div className="hidden items-center gap-1.5 rounded-md border border-border bg-bg px-2 py-1 text-xs text-fg-muted sm:flex">
          <ConnectionStatusDot status={conn.status} pulse />
          <span className="truncate">{conn.name}</span>
          {conn.status?.latencyMs != null && <span className="num text-fg-subtle">{conn.status.latencyMs} ms</span>}
        </div>
      )}
      <HealthTopBarSummary />
      <Button variant="ghost" size="icon-sm" aria-label="Search queues" onClick={onOpenSwitcher} className="sm:hidden">
        <Search />
      </Button>
      <button
        type="button"
        onClick={onOpenSwitcher}
        className="hidden h-7 items-center gap-1.5 rounded-md border border-border px-2 text-xs text-fg-subtle hover:border-border-strong hover:text-fg-muted sm:inline-flex"
      >
        <Search className="size-3.5" aria-hidden />
        <Kbd>{modKeyLabel}</Kbd>
        <Kbd>K</Kbd>
      </button>
      <UserMenu />
    </header>
  );
}

function UserMenu() {
  const { user, logout, isAdmin } = useAuth();
  const { demo, has } = useEdition();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (!user) return null;
  const initials = user.name
    .split(/\s+/)
    .map((p) => p[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="flex h-7 items-center gap-2 rounded-md px-1.5 hover:bg-surface-2"
      >
        <span className="flex size-6 items-center justify-center rounded-full bg-accent/20 text-[10px] font-semibold text-accent">{initials || "?"}</span>
        <span className="hidden max-w-32 truncate text-xs text-fg md:inline">{user.name}</span>
        <Badge variant={user.role === "admin" ? "pro" : user.role === "operator" ? "info" : "neutral"} size="xs" className="hidden md:inline-flex">
          {user.role}
        </Badge>
      </button>
      {open && (
        <div role="menu" className="absolute right-0 z-40 mt-1 w-60 rounded-lg border border-border bg-surface p-1 shadow-[var(--shadow)]">
          <div className="px-2.5 py-2">
            <p className="truncate text-[13px] font-medium text-fg">{user.name}</p>
            <p className="truncate text-xs text-fg-muted">{user.email}</p>
            <p className="mt-1 flex items-center gap-1 text-[11px] text-fg-subtle">
              <Shield className="size-3" aria-hidden /> {user.role}
              {demo && <span className="ml-1 text-warning">· demo</span>}
            </p>
          </div>
          <div className="my-1 border-t border-border" />
          {/* The audit log lives next to Settings/Users in the nav. It is added
              here rather than in the sidebar because the sidebar file is owned
              by another change in flight; move it there when that lands. */}
          {isAdmin && has("audit") && (
            <Link role="menuitem" to={routes.audit()} onClick={() => setOpen(false)} className="nav-item">
              <ScrollText className="size-3.5" aria-hidden /> Audit log
            </Link>
          )}
          <Link role="menuitem" to={routes.settings("license")} onClick={() => setOpen(false)} className="nav-item">
            <KeyRound className="size-3.5" aria-hidden /> License
          </Link>
          <button role="menuitem" type="button" onClick={() => void logout()} className="nav-item w-full text-left">
            <LogOut className="size-3.5" aria-hidden /> Log out
          </button>
        </div>
      )}
    </div>
  );
}
