import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { ArrowDownUp, BarChart3, Bell, CalendarClock, ChevronDown, Eraser, Flame, Layers, Pause, Play, Plus, RotateCcw, ScrollText, Search, Trash2, Unplug, X } from "lucide-react";
import { BULK_JOB_LIMIT, JOB_STATES, type BulkJobAction, type BulkJobActionResult, type JobState } from "@bullpane/shared";
import { cn } from "@/lib/cn";
import { routes } from "@/lib/routes";
import { formatNumber } from "@/lib/format";
import { useHotkey } from "@/lib/useHotkey";
import { STATE_COLORS } from "@/lib/stateColors";
import { useBulkJobAction, useJobAction, useJobSearch, useJobs, useQueue, useQueueAction, type JobActionKind } from "@/api/hooks";
import { useJobSelection } from "@/lib/useJobSelection";
import { BulkActionBar, BulkResultPanel, bulkActionsFor } from "@/components/BulkActionBar";
import { errorMessage } from "@/api/client";
import { useAuth } from "@/auth/AuthProvider";
import { toast } from "@/components/Toast";
import { Page } from "@/components/layout/AppShell";
import { Button } from "@/components/ui/Button";
import { Input, Select } from "@/components/ui/Input";
import { Badge } from "@/components/ui/Badge";
import { Tabs, type TabItem } from "@/components/ui/Tabs";
import { Kbd } from "@/components/ui/Kbd";
import { Sparkline } from "@/components/ui/Sparkline";
import { Spinner } from "@/components/ui/Spinner";
import { JobsTable } from "@/components/JobsTable";
import { Pagination } from "@/components/Pagination";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { AlertDialog } from "@/pages/alerts/AlertDialog";
import { useEdition } from "@/edition/useEdition";
import { QueueMetricsPanel } from "./QueueMetricsPanel";
import { AddJobDialog } from "./AddJobDialog";
import { CleanDialog } from "./CleanDialog";
import { QueueSetupPanel } from "./QueueSetupPanel";
import { SchedulersPanel } from "./SchedulersPanel";
import { QueueAlerts, QueueAlertsPill, useQueueAlerts } from "./QueueAlerts";
import { HIDE_HINT, HideIcon, useHideQueue } from "@/components/queues/hideQueue";
import { GroupCombobox } from "./GroupCombobox";
import { PauseQueueDialog } from "@/components/queues/PauseQueueDialog";

type StateTab = JobState | "groups" | "metrics" | "schedulers";

/**
 * Local route builder. `lib/routes.ts` is being edited concurrently by the
 * Redis-health work, so the metrics constant lives here instead of there.
 * Move it into `routes` once both branches have landed.
 */

function isJobState(s: string | null): s is JobState {
  return !!s && (JOB_STATES as readonly string[]).includes(s);
}

/**
 * `view` comes from the route: /q/:queue renders the job tables (unchanged
 * default), /q/:queue/metrics renders the metrics panel. Metrics is listed
 * FIRST in the tab bar but is not the default, so every existing deep link and
 * bookmark still lands on the jobs table it always did.
 */
export function QueuePage({ view = "jobs" }: { view?: "jobs" | "metrics" | "schedulers" } = {}) {
  const { connectionId = "", queue = "" } = useParams();
  const [sp, setSp] = useSearchParams();
  const navigate = useNavigate();
  const { isOperator, isAdmin } = useAuth();

  const state: JobState = isJobState(sp.get("state")) ? (sp.get("state") as JobState) : "waiting";
  const page = Math.max(1, Number(sp.get("page") ?? 1) || 1);
  const pageSize = [25, 50, 100, 200].includes(Number(sp.get("pageSize"))) ? Number(sp.get("pageSize")) : 25;
  const order = sp.get("order") === "asc" ? "asc" : "desc";
  const q = sp.get("q") ?? "";
  const groupId = sp.get("group") ?? "";
  const [draft, setDraft] = useState(q);

  const update = useCallback(
    (patch: Record<string, string | null>) => {
      setSp(
        (prev) => {
          const next = new URLSearchParams(prev);
          for (const [k, v] of Object.entries(patch)) {
            if (v == null || v === "") next.delete(k);
            else next.set(k, v);
          }
          return next;
        },
        { replace: true },
      );
    },
    [setSp],
  );

  const summary = useQueue(connectionId, queue);
  // Alerts covering this queue, directly or through a folder. Uses the already
  // cached /alerts and /folders queries, so it costs no extra request.
  const queueAlerts = useQueueAlerts(connectionId, queue);
  const hideQueue = useHideQueue(connectionId);
  const isPro = !!summary.data && (summary.data.isPro || summary.data.groupsCount > 0);
  const searching = q.trim().length > 0;
  const filteringByGroup = !searching && !!groupId;
  const showingMetrics = view === "metrics";
  const showingSchedulers = view === "schedulers";
  /** any non-jobs tab: the search box, group filter and job tables are hidden */
  const showingPanel = showingMetrics || showingSchedulers;
  const jobs = useJobs(connectionId, queue, { state, page, pageSize, order, groupId: filteringByGroup ? groupId : undefined }, { enabled: !searching && !showingPanel });
  const search = useJobSearch(connectionId, queue, { state, q: q.trim(), limit: 50 }, { enabled: searching && !showingPanel });
  const jobAction = useJobAction(connectionId, queue);
  const queueAction = useQueueAction(connectionId, queue);
  const bulkAction = useBulkJobAction(connectionId, queue);

  // Search results. Computed here (they used to be at the end of the component)
  // because the selection needs to know which ids are VISIBLE right now — and with
  // a search on screen the visible ones are the loaded results, not the state's page.
  const searchPages = search.data?.pages ?? [];
  const searchJobs = searchPages.flatMap((p) => p.jobs);
  const scanned = searchPages.reduce((sum, p) => sum + (p.scanned ?? 0), 0);
  const skippedLarge = searchPages.reduce((sum, p) => sum + (p.skippedLargePayloads ?? 0), 0);
  const searchTotal = searchPages.length ? searchPages[searchPages.length - 1].total : (summary.data?.counts?.[state] ?? 0);

  /** the jobs actually on screen — these are the ones "select all" acts on */
  const visibleJobs = searching ? searchJobs : (jobs.data?.jobs ?? []);
  const visibleIds = useMemo(() => visibleJobs.map((j) => j.id), [visibleJobs]);
  // Selection by jobId, not by index: the table repolls every 3 s and the rows
  // swap places. See lib/useJobSelection.ts.
  const selection = useJobSelection(visibleIds);
  const [bulkResult, setBulkResult] = useState<BulkJobActionResult | null>(null);
  const [pendingBulk, setPendingBulk] = useState<BulkJobAction | null>(null);
  const [confirmBulk, setConfirmBulk] = useState<BulkJobAction | null>(null);
  const [confirmRemoveJob, setConfirmRemoveJob] = useState<string | null>(null);

  const [dialog, setDialog] = useState<null | "add" | "clean" | "drain" | "obliterate" | "retryAll" | "pause">(null);
  const [alertOpen, setAlertOpen] = useState(false);
  const { has: hasFeature, gate } = useEdition();
  const [actionsOpen, setActionsOpen] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const focusSearch = useCallback(() => {
    searchRef.current?.focus();
    searchRef.current?.select();
  }, []);
  useHotkey("/", (e) => {
    e.preventDefault();
    focusSearch();
  });

  // ?search=1 deep link (cards / table rows): focus the input, then drop the flag.
  useEffect(() => {
    if (sp.get("search") !== "1") return;
    const t = window.setTimeout(focusSearch, 0);
    update({ search: null });
    return () => window.clearTimeout(t);
  }, [sp, update, focusSearch]);

  // keep the draft in sync when the URL changes from outside (back button, deep link)
  useEffect(() => setDraft(q), [q]);

  const counts = summary.data?.counts;
  const tabs = useMemo<TabItem<StateTab>[]>(() => {
    const items: TabItem<StateTab>[] = [
      { value: "metrics", label: "Metrics", icon: <BarChart3 className="size-3.5" /> },
      // Schedulers live outside the 8 states, so they get their own tab. Shown
      // always (with 0) so people learn the feature exists.
      { value: "schedulers", label: "Schedulers", count: summary.data?.schedulersCount ?? null, icon: <CalendarClock className="size-3.5" /> },
      ...JOB_STATES.map((s) => ({
        value: s as StateTab,
        label: STATE_COLORS[s].label,
        count: counts?.[s] ?? null,
        tone: STATE_COLORS[s].dotClass,
      })),
    ];
    if (summary.data?.isPro) items.push({ value: "groups", label: "Groups", count: summary.data.groupsCount, icon: <Layers className="size-3.5 text-pro" /> });
    return items;
  }, [counts, summary.data?.isPro, summary.data?.groupsCount, summary.data?.schedulersCount]);

  const runSingle = (jobId: string, action: JobActionKind) => {
    jobAction.mutate(
      { jobId, action },
      {
        onSuccess: () => toast.success(`Job ${jobId}: ${action === "remove" ? "removed" : action === "retry" ? "retried" : action === "promote" ? "promoted" : "discarded"}`),
        onError: (e) => toast.error(errorMessage(e)),
      },
    );
  };

  /**
   * A single remove goes through a confirmation. It didn't before, and a wrong
   * click on a table that reorders every 3 s deleted the wrong job with no way
   * back. `retry` and `promote` stay immediate: they are reversible.
   */
  const onAction = (jobId: string, action: JobActionKind) => {
    if (action === "remove") {
      setConfirmRemoveJob(jobId);
      return;
    }
    runSingle(jobId, action);
  };

  /** Actions that make sense for what is on screen. In a search the states are mixed. */
  const availableBulkActions = useMemo(() => bulkActionsFor(searching ? "mixed" : state), [searching, state]);

  const runBulk = (action: BulkJobAction) => {
    const jobIds = selection.selectedIds;
    if (jobIds.length === 0) return;
    if (jobIds.length > BULK_JOB_LIMIT) {
      // The server would refuse with a 400; saying it here saves the round trip and explains the cap.
      toast.error(`Select at most ${formatNumber(BULK_JOB_LIMIT)} jobs per action (${formatNumber(jobIds.length)} selected).`);
      return;
    }
    setPendingBulk(action);
    bulkAction.mutate(
      { action, jobIds },
      {
        onSuccess: (result) => {
          setBulkResult(result);
          // Only the ones that SUCCEEDED leave the selection. The failed ones stay
          // checked so the operator can retry them or look at each one.
          selection.deselect(result.ok);
          const verb = action === "retry" ? "retried" : action === "promote" ? "promoted" : "removed";
          if (result.failed.length === 0) toast.success(`${formatNumber(result.ok.length)} ${verb}`);
          else toast.error(`${formatNumber(result.ok.length)} ${verb} · ${formatNumber(result.failed.length)} failed`);
        },
        onError: (e) => toast.error(errorMessage(e)),
        onSettled: () => {
          setPendingBulk(null);
          setConfirmBulk(null);
        },
      },
    );
  };

  /** Bulk remove ALWAYS confirms, with the count and the queue name. */
  const onBulk = (action: BulkJobAction) => {
    if (action === "remove") setConfirmBulk("remove");
    else runBulk(action);
  };

  const runQueueAction = (input: Parameters<typeof queueAction.mutate>[0], success: string) =>
    queueAction.mutate(input, {
      onSuccess: () => {
        toast.success(success);
        setDialog(null);
        if (input.action === "obliterate") navigate(routes.connection(connectionId));
      },
      onError: (e) => toast.error(errorMessage(e)),
    });

  const submitSearch = () => update({ q: draft.trim() || null, page: null });
  const clearSearch = () => {
    setDraft("");
    update({ q: null, page: null });
  };

  return (
    <Page wide>
      {/* Header */}
      <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h1 className="truncate font-mono text-lg font-semibold tracking-tight">{queue}</h1>
            {summary.data?.isPaused && (
              <Badge variant="warning" dot className="tracking-wider">
                PAUSED
              </Badge>
            )}
            {summary.data?.isPro && (
              <Badge variant="pro" title="BullMQ Pro groups detected" className="tracking-wider">
                PRO
              </Badge>
            )}
            {summary.isError && <Badge variant="danger">unreachable</Badge>}
          </div>
          <p className="mt-0.5 flex items-center gap-3 text-xs text-fg-muted">
            <span className="font-mono">
              {summary.data?.prefix ?? "bull"}:{queue}
            </span>
            {summary.data?.metrics && summary.data.metrics.completed.length > 1 && (
              <span className="flex items-center gap-1.5">
                <span style={{ color: STATE_COLORS.completed.fg }}>
                  <Sparkline values={summary.data.metrics.completed} width={72} height={16} title="Completed per minute" />
                </span>
                <span style={{ color: STATE_COLORS.failed.fg }}>
                  <Sparkline values={summary.data.metrics.failed} width={72} height={16} title="Failed per minute" />
                </span>
              </span>
            )}
            <QueueAlertsPill matches={queueAlerts.matches} firing={queueAlerts.firing} />
          </p>
        </div>

        {isOperator && (
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" variant="primary" leftIcon={<Plus />} onClick={() => setDialog("add")}>
              Add job
            </Button>
            <Button size="sm" leftIcon={<Bell />} onClick={() => gate("alerts", () => setAlertOpen(true))} title="Alert on this queue">
              Create alert
            </Button>
            <Button
              size="sm"
              leftIcon={summary.data?.isPaused ? <Play /> : <Pause />}
              loading={queueAction.isPending && (queueAction.variables?.action === "pause" || queueAction.variables?.action === "resume")}
              onClick={() => (summary.data?.isPaused ? runQueueAction({ action: "resume" }, "Queue resumed") : setDialog("pause"))}
            >
              {summary.data?.isPaused ? "Resume" : "Pause"}
            </Button>
            <Button size="sm" leftIcon={<RotateCcw />} onClick={() => setDialog("retryAll")} disabled={!counts || counts.failed === 0}>
              Retry all failed
            </Button>
            <div className="relative">
              <Button size="sm" variant="secondary" rightIcon={<ChevronDown />} aria-haspopup="menu" aria-expanded={actionsOpen} onClick={() => setActionsOpen((o) => !o)}>
                More
              </Button>
              {actionsOpen && (
                <>
                  <div className="fixed inset-0 z-30" onClick={() => setActionsOpen(false)} aria-hidden />
                  <div role="menu" className="absolute right-0 z-40 mt-1 w-56 rounded-lg border border-border bg-surface p-1 shadow-[var(--shadow)]">
                    <MenuItem icon={<Eraser />} label="Clean…" hint="remove by state and age" onClick={() => (setActionsOpen(false), setDialog("clean"))} />
                    {/* Deep link into the audit log already narrowed to this queue —
                        the one place where "who touched this queue?" is the question. */}
                    {isAdmin && (
                      <Link
                        role="menuitem"
                        to={routes.audit({ connectionId, queueName: queue })}
                        onClick={() => setActionsOpen(false)}
                        className="nav-item w-full text-left"
                      >
                        <ScrollText className="size-3.5 shrink-0" aria-hidden />
                        <span className="flex-1">
                          Audit this queue
                          <span className="block text-[10px] text-fg-subtle">who paused, cleaned or drained it</span>
                        </span>
                      </Link>
                    )}
                    {isOperator && (
                      <MenuItem
                        icon={<HideIcon />}
                        label="Hide from the lists"
                        hint={HIDE_HINT}
                        onClick={() => (setActionsOpen(false), hideQueue.hide(queue))}
                      />
                    )}
                    {isAdmin && <MenuItem icon={<Trash2 />} label="Drain" hint="remove all waiting jobs" onClick={() => (setActionsOpen(false), setDialog("drain"))} />}
                    {/* Obliterate sits next to Hide on purpose, and the hints
                        spell out the difference: hiding drops it from the list and is
                        reversible, obliterate DELETES the queue and the jobs, and is not. */}
                    {isAdmin && <MenuItem icon={<Flame />} label="Obliterate…" hint="deletes the queue and every job · permanent" danger onClick={() => (setActionsOpen(false), setDialog("obliterate"))} />}
                  </div>
                </>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Setup (what Redis knows about this queue's configuration) */}
      <QueueSetupPanel connectionId={connectionId} queue={queue} className="mb-3" />

      {/* Alerts already watching this queue (directly, or via a folder it belongs to) */}
      <div className="mb-3">
        <QueueAlerts
          connectionId={connectionId}
          queueName={queue}
          matches={queueAlerts.matches}
          onCreate={() => gate("alerts", () => setAlertOpen(true))}
        />
      </div>

      {/* Search — first thing in the toolbar (jobs view only) */}
      {!showingPanel && (
      <form
        className="mb-3 flex flex-wrap items-center gap-2"
        role="search"
        onSubmit={(e) => {
          e.preventDefault();
          submitSearch();
        }}
      >
        <div className="relative min-w-72 flex-1">
          <Input
            ref={searchRef}
            leftIcon={<Search />}
            placeholder={`Search job data, name, id or error in ${state}…`}
            aria-label="Search jobs"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.preventDefault();
                clearSearch();
                (e.target as HTMLInputElement).blur();
              }
            }}
            className="!h-9 pr-16 text-[13px]"
          />
          <span className="absolute top-1/2 right-2 flex -translate-y-1/2 items-center gap-1">
            {draft || searching ? (
              <button type="button" className="rounded p-0.5 text-fg-subtle hover:text-fg" aria-label="Clear search" onClick={clearSearch}>
                <X className="size-3.5" />
              </button>
            ) : (
              <span className="hidden items-center gap-1 sm:flex">
                <Kbd>/</Kbd>
              </span>
            )}
          </span>
        </div>
        <Select aria-label="State to search" className="!h-9 !w-auto" value={state} onChange={(e) => update({ state: e.target.value, page: null, group: null })} options={JOB_STATES.map((s) => ({ value: s, label: `in ${STATE_COLORS[s].label}` }))} />
        <Button type="submit" size="md" variant={searching ? "secondary" : "primary"} leftIcon={<Search />} disabled={!draft.trim() && !searching}>
          Search
        </Button>
        <span className="hidden text-[11px] text-fg-subtle lg:inline">Enter to search · Esc to clear · substring match, server-side</span>
      </form>
      )}

      {/* State tabs + group filter */}
      <div className="mb-3 flex flex-wrap items-end gap-3 border-b border-border">
        <div className={cn("min-w-0 flex-1 transition-opacity", !showingPanel && (filteringByGroup || searching) && "opacity-50")} title={filteringByGroup && !showingPanel ? "Clear the group filter to browse by state" : undefined}>
          <Tabs<StateTab>
            aria-label="Job state"
            items={tabs}
            value={showingMetrics ? "metrics" : showingSchedulers ? "schedulers" : state}
            onChange={(v) => {
              if (v === "groups") navigate(routes.groups(connectionId, queue));
              else if (v === "metrics") navigate(routes.queueMetrics(connectionId, queue));
              else if (v === "schedulers") navigate(`/c/${encodeURIComponent(connectionId)}/q/${encodeURIComponent(queue)}/schedulers`);
              else if (showingPanel) navigate(routes.queue(connectionId, queue, v));
              else update({ state: v, page: null, group: null });
            }}
            className="!border-b-0"
            size="sm"
          />
        </div>
        {isPro && !searching && !showingPanel && (
          <div className="flex items-center gap-2 pb-1.5">
            {filteringByGroup && (
              <span className="text-[11px] text-fg-muted">
                showing group <span className="font-mono text-fg">{groupId}</span>&apos;s waiting jobs
              </span>
            )}
            <GroupCombobox connectionId={connectionId} queue={queue} value={groupId} onChange={(gid) => update({ group: gid || null, page: null })} />
          </div>
        )}
        {!searching && !showingPanel && (
          <Button size="sm" variant="ghost" className="mb-1" leftIcon={<ArrowDownUp />} onClick={() => update({ order: order === "desc" ? "asc" : "desc" })} title="Toggle order">
            {order === "desc" ? "Newest first" : "Oldest first"}
          </Button>
        )}
      </div>

      {/* Metrics, schedulers, or the job tables */}
      {showingSchedulers ? (
        <SchedulersPanel connectionId={connectionId} queue={queue} />
      ) : showingMetrics ? (
        <QueueMetricsPanel
          connectionId={connectionId}
          queue={queue}
          summary={summary.data}
          onOpenState={(s) => navigate(routes.queue(connectionId, queue, s))}
        />
      ) : (
      <div className="card overflow-hidden">
        {searching ? (
          <>
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border bg-surface-2/50 px-3 py-2 text-xs" role="status">
              <span className="flex items-center gap-2 text-fg-muted">
                <Search className="size-3.5 text-fg-subtle" aria-hidden />
                {search.isFetching && !search.isFetchingNextPage ? (
                  <Spinner label={`Scanning ${state} jobs for "${q}"…`} />
                ) : (
                  <>
                    <span className="num font-semibold text-fg">{formatNumber(searchJobs.length)}</span> {searchJobs.length === 1 ? "match" : "matches"} · scanned <span className="num text-fg">{formatNumber(Math.min(scanned, searchTotal))}</span> of{" "}
                    <span className="num text-fg">{formatNumber(searchTotal)}</span> jobs in <span className={STATE_COLORS[state].textClass}>{state}</span>
                    {!search.hasNextPage && search.data && <span className="text-fg-subtle"> · whole state scanned</span>}
                    {skippedLarge > 0 && (
                      <span className="text-fg-subtle" title="Payloads above the search size cap are not read into Lua; those jobs still match on id, name and error.">
                        {" "}· {formatNumber(skippedLarge)} {skippedLarge === 1 ? "payload" : "payloads"} too large to search inside
                      </span>
                    )}
                  </>
                )}
              </span>
              <span className="flex items-center gap-2">
                {search.hasNextPage && (
                  <Button size="sm" onClick={() => search.fetchNextPage()} loading={search.isFetchingNextPage}>
                    Scan more
                  </Button>
                )}
                <Button size="sm" variant="ghost" leftIcon={<X />} onClick={clearSearch}>
                  Clear
                </Button>
              </span>
            </div>
            {bulkResult && <BulkResultPanel result={bulkResult} onDismiss={() => setBulkResult(null)} />}
            {/*
              With a search on screen, the selection is over the loaded RESULTS —
              exactly the use case: "reprocess the 50 from tenant-globex".
              The bar says so via `searching` so nobody thinks it took the whole
              queue.
            */}
            {isOperator && <BulkActionBar selection={selection} state="mixed" queue={queue} actions={availableBulkActions} onRun={onBulk} pending={pendingBulk} searching />}
            <JobsTable
              connectionId={connectionId}
              queue={queue}
              jobs={search.data ? searchJobs : undefined}
              loading={search.isLoading}
              error={search.error}
              emptyText={search.hasNextPage ? "No matches yet — scan more to keep looking" : `No ${state} job contains "${q}"`}
              canOperate={isOperator}
              onAction={onAction}
              pendingId={jobAction.isPending ? jobAction.variables?.jobId : null}
              showState={false}
              showGroup={isPro}
              onGroupClick={(gid) => {
                clearSearch();
                update({ group: gid, page: null });
              }}
              highlight={q}
              selection={isOperator ? selection : undefined}
            />
            <div className="flex items-center justify-between border-t border-border px-3 py-2 text-xs text-fg-subtle">
              <span>Each scan reads a bounded slice of the state to keep Redis happy.</span>
              {search.hasNextPage && (
                <Button size="sm" onClick={() => search.fetchNextPage()} loading={search.isFetchingNextPage}>
                  Scan more
                </Button>
              )}
            </div>
          </>
        ) : (
          <>
            {/*
              `stalled` is NOT a BullMQ state: it is an auxiliary SET, and a
              stalled job answers `active` in getState(). That is why there is no
              "stalled" tab — it would lie about the model. What exists is this
              notice on the `active` tab, because "active 8" without saying that 3
              are stuck is a real blind spot.
            */}
            {state === "active" && (summary.data?.stalledCount ?? 0) > 0 && (
              <div className="flex items-start gap-2 border-b border-border bg-warning/10 px-3 py-2 text-xs" role="status">
                <Unplug className="mt-0.5 size-3.5 shrink-0 text-warning" aria-hidden />
                <span>
                  <span className="num font-semibold text-fg">{formatNumber(summary.data?.stalledCount ?? 0)}</span> of these are stalled (worker lost the lock).
                  <span className="text-fg-muted"> BullMQ still reports them as active; the next stalled check moves them back to waiting and bumps their stall counter.</span>
                </span>
              </div>
            )}
            {bulkResult && <BulkResultPanel result={bulkResult} onDismiss={() => setBulkResult(null)} />}
            {isOperator && <BulkActionBar selection={selection} state={state} queue={queue} actions={availableBulkActions} onRun={onBulk} pending={pendingBulk} />}
            <JobsTable
              connectionId={connectionId}
              queue={queue}
              jobs={jobs.data?.jobs}
              loading={jobs.isLoading}
              error={jobs.error}
              emptyText={filteringByGroup ? `No waiting jobs in group ${groupId}` : "No jobs in this state"}
              canOperate={isOperator}
              onAction={onAction}
              pendingId={jobAction.isPending ? jobAction.variables?.jobId : null}
              showState={false}
              showGroup={isPro}
              onGroupClick={(gid) => update({ group: gid, page: null })}
              selection={isOperator ? selection : undefined}
            />
            <div className={cn("border-t border-border px-3 py-2", jobs.isFetching && "opacity-80")}>
              <Pagination
                page={page}
                pageSize={pageSize}
                total={jobs.data?.total ?? (filteringByGroup ? 0 : counts?.[state] ?? 0)}
                count={jobs.data?.jobs.length}
                onPage={(p) => update({ page: String(p) })}
                onPageSize={(s) => update({ pageSize: String(s), page: null })}
              />
            </div>
          </>
        )}
      </div>
      )}

      {/* Dialogs */}
      {isOperator && <AddJobDialog open={dialog === "add"} onClose={() => setDialog(null)} connectionId={connectionId} queue={queue} />}
      {isOperator && hasFeature("alerts") && alertOpen && (
        <AlertDialog open onClose={() => setAlertOpen(false)} alert={null} initialScope={{ type: "queue", connectionId, queueName: queue }} />
      )}
      {isOperator && (
        <CleanDialog
          open={dialog === "clean"}
          onClose={() => setDialog(null)}
          connectionId={connectionId}
          queue={queue}
          defaultState={state === "waiting" ? "wait" : state === "waiting-children" ? "completed" : state}
        />
      )}
      {/*
        Bulk remove: confirmation with the COUNT and the queue name. It is
        irreversible, and the count is what prevents the "I thought it was 3".
      */}
      <ConfirmDialog
        open={confirmBulk === "remove"}
        onClose={() => setConfirmBulk(null)}
        title="Remove selected jobs"
        description={`Remove ${formatNumber(selection.selectedIds.length)} ${selection.selectedIds.length === 1 ? "job" : "jobs"} from ${queue}? This cannot be undone.`}
        confirmText={`Remove ${formatNumber(selection.selectedIds.length)}`}
        danger
        loading={pendingBulk === "remove"}
        onConfirm={() => runBulk("remove")}
      />
      {/* A single remove confirms too — it didn't before, and the table
          reorders every 3 s. */}
      <ConfirmDialog
        open={confirmRemoveJob !== null}
        onClose={() => setConfirmRemoveJob(null)}
        title="Remove job"
        description={`Remove job ${confirmRemoveJob ?? ""} from ${queue}? This cannot be undone.`}
        confirmText="Remove"
        danger
        loading={jobAction.isPending}
        onConfirm={() => {
          if (confirmRemoveJob) runSingle(confirmRemoveJob, "remove");
          setConfirmRemoveJob(null);
        }}
      />
      <PauseQueueDialog
        queue={dialog === "pause" ? queue : null}
        onClose={() => setDialog(null)}
        loading={queueAction.isPending && queueAction.variables?.action === "pause"}
        onConfirm={(reason) => runQueueAction({ action: "pause", body: reason ? { reason } : {} }, "Queue paused")}
      />
      <ConfirmDialog
        open={dialog === "retryAll"}
        onClose={() => setDialog(null)}
        title="Retry all failed jobs"
        description={`Moves ${formatNumber(counts?.failed ?? 0)} failed jobs in ${queue} back to waiting.`}
        confirmText="Retry all"
        loading={queueAction.isPending}
        onConfirm={() => runQueueAction({ action: "retry-all", body: { state: "failed" } }, "Retrying all failed jobs")}
      />
      <ConfirmDialog
        open={dialog === "drain"}
        onClose={() => setDialog(null)}
        title="Drain queue"
        description={`Removes every waiting and prioritized job in ${queue}. Active, completed and failed jobs are kept.`}
        confirmText="Drain"
        danger
        loading={queueAction.isPending}
        onConfirm={() => runQueueAction({ action: "drain", body: { includeDelayed: false } }, "Queue drained")}
      />
      <ConfirmDialog
        open={dialog === "obliterate"}
        onClose={() => setDialog(null)}
        title="Obliterate queue"
        description="Deletes every key of this queue from Redis, including completed and failed history. This cannot be undone."
        confirmText="Obliterate"
        danger
        typeToConfirm={queue}
        loading={queueAction.isPending}
        onConfirm={() => runQueueAction({ action: "obliterate" }, `${queue} obliterated`)}
      />
    </Page>
  );
}

function MenuItem({ icon, label, hint, danger, onClick }: { icon: React.ReactNode; label: string; hint?: string; danger?: boolean; onClick: () => void }) {
  return (
    <button role="menuitem" type="button" onClick={onClick} className={cn("nav-item h-auto w-full py-1.5 text-left [&_svg]:size-3.5", danger && "text-danger hover:text-danger")}>
      {icon}
      <span className="flex flex-col">
        <span className={cn(!danger && "text-fg")}>{label}</span>
        {hint && <span className="text-[11px] text-fg-subtle">{hint}</span>}
      </span>
    </button>
  );
}
