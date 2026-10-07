import { useEffect, useRef, useState } from "react";
import { SPREAD_MAX_MS, type BulkJobFailure } from "@bullpane/shared";
import { useCountMatching, usePromoteMatching } from "@/api/hooks";
import { errorMessage } from "@/api/client";
import { formatDuration, formatNumber } from "@/lib/format";
import { Dialog } from "@/components/ui/Dialog";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Spinner } from "@/components/ui/Spinner";
import { toast } from "@/components/Toast";

export interface PromoteMatch {
  query?: string;
  groupId?: string;
}

/** Count calls per match before the preview says "at least": each is bounded server-side. */
const COUNT_CALLS = 20;

interface Counted {
  /** per match, in the order given */
  each: number[];
  total: number;
  /** false when a match was not counted to the end (COUNT_CALLS reached) */
  exact: boolean;
}

interface Progress {
  promoted: number;
  rescheduled: number;
  unchanged: number;
  failedCount: number;
  failed: BulkJobFailure[];
  done: boolean;
}

/** `datetime-local` value for a unix ms, in the browser's time zone. */
function toLocalInput(ms: number): string {
  const d = new Date(ms - new Date(ms).getTimezoneOffset() * 60_000);
  return d.toISOString().slice(0, 16);
}

/**
 * Promotes every delayed job of one or more groups and / or matching a search, not
 * only the ones on screen. It counts first (the preview: nothing runs before the
 * operator sees how many), then either runs them now or, optionally, spreads them
 * over a window: soonest first, evenly up to the chosen time, never later than they
 * were. Server calls are bounded and return cursors; this loops and can stop between
 * calls. With several groups, each is laid out over the same window.
 */
export function PromoteMatchingDialog({
  open,
  onClose,
  connectionId,
  queue,
  matches,
}: {
  open: boolean;
  /** `ran` is true once anything was promoted or rescheduled (not on a plain cancel) */
  onClose: (outcome: { ran: boolean }) => void;
  connectionId: string;
  queue: string;
  matches: PromoteMatch[];
}) {
  const count = useCountMatching(connectionId, queue);
  const promote = usePromoteMatching(connectionId, queue);
  const [counted, setCounted] = useState<Counted | null>(null);
  const [countError, setCountError] = useState<string | null>(null);
  const [mode, setMode] = useState<"now" | "spread">("now");
  const [until, setUntil] = useState(() => toLocalInput(Date.now() + 2 * 3600_000));
  const [progress, setProgress] = useState<Progress | null>(null);
  const [running, setRunning] = useState(false);
  const stop = useRef(false);

  const what =
    matches.length > 1
      ? `of ${formatNumber(matches.length)} groups`
      : [matches[0]?.groupId ? `of group ${matches[0].groupId}` : null, matches[0]?.query ? `containing "${matches[0].query}"` : null].filter(Boolean).join(" and ");

  // The callers build `matches` inline; its content, not its identity, is what counts.
  const matchesKey = JSON.stringify(matches);
  // The preview: count before anything runs.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setCounted(null);
    setCountError(null);
    setProgress(null);
    (async () => {
      const each: number[] = [];
      let exact = true;
      for (const m of matches) {
        let n = 0;
        let cursor: string | undefined;
        let calls = 0;
        do {
          const r = await count.mutateAsync({ ...m, cursor });
          n += r.matched;
          cursor = r.nextCursor ?? undefined;
          calls++;
        } while (cursor !== undefined && calls < COUNT_CALLS && !cancelled);
        if (cursor !== undefined) exact = false;
        each.push(n);
        if (cancelled) return;
      }
      if (!cancelled) setCounted({ each, total: each.reduce((a, b) => a + b, 0), exact });
    })().catch((e) => !cancelled && setCountError(errorMessage(e)));
    return () => {
      cancelled = true;
    };
  }, [open, matchesKey]);

  const untilMs = new Date(until).getTime();
  const spreadError =
    mode !== "spread" ? null : !Number.isFinite(untilMs) || untilMs <= Date.now() ? "Pick a time in the future" : untilMs - Date.now() > SPREAD_MAX_MS ? "At most 7 days from now" : null;

  const start = async () => {
    if (!counted) return;
    stop.current = false;
    setRunning(true);
    const from = Date.now();
    let acc: Progress = { promoted: 0, rescheduled: 0, unchanged: 0, failedCount: 0, failed: [], done: false };
    setProgress(acc);
    try {
      for (let i = 0; i < matches.length && !stop.current; i++) {
        let cursor: string | undefined;
        let offset = 0;
        do {
          const spread = mode === "spread" ? { from, until: untilMs, total: Math.max(1, counted.each[i] ?? 1), offset } : undefined;
          const r = await promote.mutateAsync({ ...matches[i], cursor, spread });
          offset += r.matched;
          acc = {
            promoted: acc.promoted + r.promoted,
            rescheduled: acc.rescheduled + r.rescheduled,
            unchanged: acc.unchanged + r.unchanged,
            failedCount: acc.failedCount + r.failedCount,
            failed: [...acc.failed, ...r.failed].slice(0, 20),
            done: false,
          };
          setProgress(acc);
          cursor = r.nextCursor ?? undefined;
        } while (cursor !== undefined && !stop.current);
      }
      acc = { ...acc, done: !stop.current };
      setProgress(acc);
      const did = mode === "spread" ? `${formatNumber(acc.rescheduled)} rescheduled` : `${formatNumber(acc.promoted)} promoted`;
      if (acc.failedCount === 0) toast.success(did);
      else toast.error(`${did} · ${formatNumber(acc.failedCount)} failed`);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setRunning(false);
    }
  };

  const close = () => {
    stop.current = true;
    onClose({ ran: !!progress });
  };
  const finished = !!progress && !running;

  return (
    <Dialog
      open={open}
      onClose={close}
      size="sm"
      title="Promote every matching delayed job"
      description={`Every delayed job ${what} in ${queue}, not only the ones on screen. On a BullMQ Pro queue grouped jobs keep their group and its rate limit.`}
      footer={
        running ? (
          <Button variant="ghost" size="sm" onClick={() => (stop.current = true)}>
            Stop after this batch
          </Button>
        ) : finished ? (
          <Button size="sm" onClick={close}>
            Close
          </Button>
        ) : (
          <>
            <Button variant="ghost" size="sm" onClick={close}>
              Cancel
            </Button>
            <Button size="sm" onClick={start} disabled={!counted || counted.total === 0 || !!spreadError}>
              {mode === "spread" ? "Spread" : "Promote"} {counted ? `${counted.exact ? "" : "≥ "}${formatNumber(counted.total)}` : ""}
            </Button>
          </>
        )
      }
    >
      <div className="space-y-3 text-xs">
        {!progress && (
          <>
            <p role="status">
              {countError ? (
                <span className="text-danger">{countError}</span>
              ) : counted ? (
                <>
                  <span className="num font-semibold text-fg">
                    {counted.exact ? "" : "at least "}
                    {formatNumber(counted.total)}
                  </span>{" "}
                  delayed {counted.total === 1 ? "job matches" : "jobs match"}.
                  {!counted.exact && <span className="text-fg-subtle"> Counting stopped early on a large state; the action still covers every match.</span>}
                </>
              ) : (
                <Spinner label="Counting matching delayed jobs…" />
              )}
            </p>
            <fieldset className="space-y-2" disabled={!counted}>
              <label className="flex items-center gap-2">
                <input type="radio" name="promote-mode" checked={mode === "now"} onChange={() => setMode("now")} />
                Run them now
              </label>
              <label className="flex items-center gap-2">
                <input type="radio" name="promote-mode" checked={mode === "spread"} onChange={() => setMode("spread")} />
                Spread them until a time, keeping their order
              </label>
              {mode === "spread" && (
                <div className="pl-6">
                  <Input
                    type="datetime-local"
                    aria-label="Spread until"
                    value={until}
                    min={toLocalInput(Date.now())}
                    onChange={(e) => setUntil(e.target.value)}
                    error={spreadError ?? undefined}
                    hint={
                      spreadError || !counted
                        ? undefined
                        : `About one every ${formatDuration(Math.max(1, (untilMs - Date.now()) / Math.max(1, Math.max(...counted.each, 1))))}${matches.length > 1 ? " per group" : ""}. A job already due sooner keeps its time.`
                    }
                  />
                </div>
              )}
            </fieldset>
          </>
        )}
        {progress && (
          <div className="space-y-2" role="status">
            <p>
              {mode === "spread" ? (
                <>
                  <span className="num font-semibold text-fg">{formatNumber(progress.rescheduled)}</span> rescheduled
                  {progress.unchanged > 0 && <> · {formatNumber(progress.unchanged)} already due sooner, left as they were</>}
                </>
              ) : (
                <>
                  <span className="num font-semibold text-fg">{formatNumber(progress.promoted)}</span> promoted
                </>
              )}
              {progress.failedCount > 0 && (
                <>
                  {" "}· <span className="num font-semibold text-danger">{formatNumber(progress.failedCount)}</span> failed
                </>
              )}
              {progress.done ? " · done" : running ? "…" : " · stopped"}
            </p>
            {progress.failed.length > 0 && (
              <ul className="max-h-32 overflow-auto rounded border border-border p-2 font-mono text-[11px] text-fg-muted">
                {progress.failed.map((f) => (
                  <li key={f.jobId} className="truncate">
                    {f.jobId}: {f.reason}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>
    </Dialog>
  );
}
