import { useEffect, useMemo, useRef, useState } from "react";
import type { JobState } from "@bullpane/shared";
import { useNavigate } from "react-router-dom";
import { CornerDownLeft, Database, Search } from "lucide-react";
import { cn } from "@/lib/cn";
import { routes } from "@/lib/routes";
import { queueLandingState } from "@/lib/queueLanding";
import { formatCompact } from "@/lib/format";
import { useAllQueues } from "@/api/hooks";
import { Kbd } from "@/components/ui/Kbd";

interface Item {
  key: string;
  connectionId: string;
  connectionName: string;
  queue: string;
  waiting: number;
  failed: number;
  paused: boolean;
  /** estado em que abrir a fila (failed → waiting → completed), ver lib/queueLanding.ts */
  landing: JobState;
}

/** Cmd/Ctrl+K: client-side filter over the cached queue lists. */
export function QuickSwitcher({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { byConnection } = useAllQueues();
  const navigate = useNavigate();
  const [q, setQ] = useState("");
  const [idx, setIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  const items = useMemo<Item[]>(
    () =>
      byConnection.flatMap(({ connection, queues }) =>
        queues.map((qu) => ({
          key: `${connection.id}/${qu.name}`,
          connectionId: connection.id,
          connectionName: connection.name,
          queue: qu.name,
          waiting: qu.counts.waiting + qu.counts.prioritized,
          failed: qu.counts.failed,
          paused: qu.isPaused,
          landing: queueLandingState(qu.counts),
        })),
      ),
    [byConnection],
  );

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const scored = items
      .map((it) => ({ it, score: score(needle, it) }))
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score || a.it.queue.localeCompare(b.it.queue));
    return scored.slice(0, 50).map((s) => s.it);
  }, [items, q]);

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

  const go = (it: Item | undefined) => {
    if (!it) return;
    onClose();
    navigate(routes.queue(it.connectionId, it.queue, it.landing));
  };

  return (
    <dialog
      ref={dialogRef}
      className="dialog !mt-[12vh]"
      style={{ ["--dialog-w" as string]: "36rem" }}
      aria-label="Jump to queue"
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
              placeholder="Type a queue name…"
              aria-label="Queue name"
              aria-activedescendant={filtered[idx] ? `qs-${filtered[idx].key}` : undefined}
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
          <ul id="qs-list" ref={listRef} role="listbox" className="max-h-[50vh] overflow-y-auto p-1">
            {filtered.length === 0 && (
              <li className="px-3 py-8 text-center text-xs text-fg-subtle">
                {items.length === 0 ? "No queues loaded yet" : "No queue matches"}
              </li>
            )}
            {filtered.map((it, i) => (
              <li
                key={it.key}
                id={`qs-${it.key}`}
                role="option"
                aria-selected={i === idx}
                onMouseEnter={() => setIdx(i)}
                onClick={() => go(it)}
                className={cn("flex cursor-pointer items-center gap-2 rounded-md px-2.5 py-1.5 text-[13px]", i === idx ? "bg-surface-3 text-fg" : "text-fg-muted")}
              >
                <Database className="size-3.5 shrink-0 text-fg-subtle" aria-hidden />
                <span className="truncate font-medium text-fg">
                  <Highlight text={it.queue} needle={q} />
                </span>
                <span className="truncate text-xs text-fg-subtle">{it.connectionName}</span>
                {it.paused && <span className="rounded bg-surface-3 px-1 text-[9px] uppercase">paused</span>}
                <span className="num ml-auto text-xs text-fg-subtle">{formatCompact(it.waiting)} waiting</span>
                {it.failed > 0 && <span className="num text-xs text-danger">{formatCompact(it.failed)} failed</span>}
                {i === idx && <CornerDownLeft className="size-3.5 text-fg-subtle" aria-hidden />}
              </li>
            ))}
          </ul>
        </div>
      )}
    </dialog>
  );
}

function score(needle: string, it: Item): number {
  if (!needle) return 1;
  const name = it.queue.toLowerCase();
  if (name === needle) return 100;
  if (name.startsWith(needle)) return 80;
  if (name.includes(needle)) return 60;
  if (it.connectionName.toLowerCase().includes(needle)) return 20;
  // subsequence match
  let j = 0;
  for (let i = 0; i < name.length && j < needle.length; i++) if (name[i] === needle[j]) j++;
  return j === needle.length ? 10 : 0;
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
