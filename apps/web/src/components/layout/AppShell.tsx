import { useCallback, useState } from "react";
import { Outlet, useLocation, useMatch } from "react-router-dom";
import { useEffect } from "react";
import { cn } from "@/lib/cn";
import { useHotkey } from "@/lib/useHotkey";
import { Sidebar } from "./Sidebar";
import { TopBar } from "./TopBar";
import { QuickSwitcher } from "./QuickSwitcher";
import { HiddenQueueBanner } from "@/components/queues/HiddenQueueBanner";

export function AppShell() {
  const [switcher, setSwitcher] = useState(false);
  const [mobileSidebar, setMobileSidebar] = useState(false);
  const location = useLocation();

  /**
   * A hidden queue stays reachable by direct URL, so the notice explaining WHY
   * it is missing from the sidebar is rendered here, once, above whatever queue
   * sub-route is open (jobs, metrics, schedulers, groups, a single job).
   * Doing it in the shell also keeps pages/queue/** untouched.
   */
  // Both hooks always run (no conditional hook calls); the deeper route wins.
  const queueSubRoute = useMatch("/c/:connectionId/q/:queue/*");
  const queueRoute = useMatch("/c/:connectionId/q/:queue");
  const queueMatch = queueSubRoute ?? queueRoute;

  const openSwitcher = useCallback(() => setSwitcher(true), []);
  useHotkey("k", (e) => {
    e.preventDefault();
    setSwitcher((s) => !s);
  }, { mod: true, allowInInputs: true });

  useEffect(() => {
    setMobileSidebar(false);
  }, [location.pathname]);

  return (
    <div className="flex h-screen w-full overflow-hidden bg-bg">
      <Sidebar onOpenSwitcher={openSwitcher} className="hidden lg:flex" />
      {mobileSidebar && (
        <div className="fixed inset-0 z-40 flex lg:hidden">
          <div className="absolute inset-0 bg-black/50" onClick={() => setMobileSidebar(false)} aria-hidden />
          <Sidebar onOpenSwitcher={openSwitcher} onNavigate={() => setMobileSidebar(false)} className="relative z-10 shadow-[var(--shadow)]" />
        </div>
      )}
      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar onOpenSwitcher={openSwitcher} onToggleSidebar={() => setMobileSidebar((s) => !s)} />
        <main className={cn("min-h-0 flex-1 overflow-y-auto")}>
          {queueMatch?.params.connectionId && queueMatch.params.queue && (
            <HiddenQueueBanner connectionId={queueMatch.params.connectionId} queueName={queueMatch.params.queue} />
          )}
          <Outlet />
        </main>
      </div>
      <QuickSwitcher open={switcher} onClose={() => setSwitcher(false)} />
    </div>
  );
}

/** Standard page padding + max width. */
export function Page({ children, className, wide }: { children: React.ReactNode; className?: string; wide?: boolean }) {
  return <div className={cn("mx-auto w-full px-5 py-5", wide ? "max-w-none" : "max-w-[1400px]", className)}>{children}</div>;
}

export function PageHeader({
  title,
  description,
  actions,
  className,
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("mb-4 flex flex-wrap items-start justify-between gap-3", className)}>
      <div className="min-w-0">
        <h1 className="truncate text-lg font-semibold tracking-tight text-fg">{title}</h1>
        {description && <p className="mt-0.5 text-xs text-fg-muted">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}
