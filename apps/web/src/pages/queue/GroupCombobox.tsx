import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Check, ChevronDown, Layers, X } from "lucide-react";
import { cn } from "@/lib/cn";
import { formatCompact } from "@/lib/format";
import { useGroups } from "@/api/hooks";

/**
 * Searchable single-select over the queue's BullMQ Pro groups.
 * "" means "All groups". Typing an id that is not in the (first 200) listed
 * groups still lets you pick it, since group ids are free-form.
 */
export function GroupCombobox({
  connectionId,
  queue,
  value,
  onChange,
  disabled,
  className,
}: {
  connectionId: string;
  queue: string;
  value: string;
  onChange: (groupId: string) => void;
  disabled?: boolean;
  className?: string;
}) {
  const groups = useGroups(connectionId, queue, { page: 1, pageSize: 200 });
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [idx, setIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const listId = useId();

  const list = groups.data?.groups ?? [];
  const options = useMemo(() => {
    const t = text.trim().toLowerCase();
    const hits = list.filter((g) => !t || g.id.toLowerCase().includes(t)).slice(0, 100);
    const exact = t && list.some((g) => g.id.toLowerCase() === t);
    const items: { id: string; label: string; waiting?: number; custom?: boolean }[] = [];
    if (!t) items.push({ id: "", label: "All groups" });
    items.push(...hits.map((g) => ({ id: g.id, label: g.id, waiting: g.waiting })));
    if (t && !exact) items.push({ id: text.trim(), label: `Use "${text.trim()}"`, custom: true });
    return items;
  }, [list, text]);

  useEffect(() => setIdx(0), [text, open]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const pick = (id: string) => {
    onChange(id);
    setOpen(false);
    setText("");
  };

  return (
    <div ref={rootRef} className={cn("relative", className)}>
      <div className={cn("control flex !h-7 !w-auto min-w-44 items-center gap-1.5 !px-2 text-xs", disabled && "cursor-not-allowed opacity-50", value && "border-pro/60")}>
        <Layers className="size-3.5 shrink-0 text-pro" aria-hidden />
        {open ? (
          <input
            ref={inputRef}
            autoFocus
            role="combobox"
            aria-expanded={open}
            aria-controls={listId}
            aria-autocomplete="list"
            aria-label="Filter by group"
            className="min-w-0 flex-1 bg-transparent font-mono outline-none placeholder:font-sans placeholder:text-fg-subtle"
            placeholder="Type a group id…"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") (e.preventDefault(), setIdx((i) => Math.min(options.length - 1, i + 1)));
              else if (e.key === "ArrowUp") (e.preventDefault(), setIdx((i) => Math.max(0, i - 1)));
              else if (e.key === "Enter") (e.preventDefault(), options[idx] && pick(options[idx].id));
              else if (e.key === "Escape") (e.preventDefault(), setOpen(false), setText(""));
            }}
          />
        ) : (
          <button type="button" disabled={disabled} className="flex min-w-0 flex-1 items-center gap-1 text-left" onClick={() => setOpen(true)} aria-haspopup="listbox" aria-expanded={open} title={value ? `Showing group ${value}` : "Filter jobs by group"}>
            {value ? (
              <span className="truncate font-mono text-fg">{value}</span>
            ) : (
              <span className="truncate text-fg-muted">
                All groups{groups.data ? <span className="num text-fg-subtle"> · {formatCompact(groups.data.total)}</span> : null}
              </span>
            )}
          </button>
        )}
        {value && !disabled ? (
          <button type="button" className="rounded p-0.5 text-fg-subtle hover:text-fg" aria-label="Clear group filter" onClick={() => pick("")}>
            <X className="size-3" />
          </button>
        ) : (
          <ChevronDown className="size-3.5 shrink-0 text-fg-subtle" aria-hidden />
        )}
      </div>

      {open && (
        <ul id={listId} role="listbox" className="absolute left-0 z-40 mt-1 max-h-64 w-72 overflow-auto rounded-md border border-border bg-surface p-1 text-xs shadow-[var(--shadow)]">
          {groups.isLoading && <li className="px-2 py-1.5 text-fg-subtle">Loading groups…</li>}
          {!groups.isLoading && options.length === 0 && <li className="px-2 py-1.5 text-fg-subtle">No groups</li>}
          {options.map((o, i) => {
            const selected = o.id === value;
            return (
              <li
                key={o.custom ? `custom:${o.id}` : o.id || "__all__"}
                role="option"
                aria-selected={selected}
                className={cn("flex cursor-pointer items-center gap-2 rounded px-2 py-1", i === idx ? "bg-surface-3 text-fg" : "text-fg-muted hover:bg-surface-2 hover:text-fg")}
                onMouseEnter={() => setIdx(i)}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => pick(o.id)}
              >
                <span className={cn("min-w-0 flex-1 truncate", o.id && !o.custom && "font-mono")}>{o.label}</span>
                {o.waiting != null && <span className="num text-[10px] text-fg-subtle">{formatCompact(o.waiting)} waiting</span>}
                {selected && <Check className="size-3.5 text-accent" aria-hidden />}
              </li>
            );
          })}
          {groups.data && groups.data.total > list.length && <li className="border-t border-border px-2 py-1 text-[10px] text-fg-subtle">Showing the first {list.length} of {formatCompact(groups.data.total)} groups — type an id to filter or use it directly.</li>}
        </ul>
      )}
    </div>
  );
}
