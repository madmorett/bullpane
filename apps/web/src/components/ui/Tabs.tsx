import { useRef, type KeyboardEvent, type ReactNode } from "react";
import { Lock } from "lucide-react";
import { cn } from "@/lib/cn";
import { formatCompact } from "@/lib/format";

export interface TabItem<T extends string> {
  value: T;
  label: ReactNode;
  count?: number | null;
  icon?: ReactNode;
  locked?: boolean;
  /** dot colour class, e.g. "bg-danger" */
  tone?: string;
  disabled?: boolean;
}

export interface TabsProps<T extends string> {
  items: TabItem<T>[];
  value: T;
  onChange: (value: T, item: TabItem<T>) => void;
  className?: string;
  size?: "sm" | "md";
  variant?: "underline" | "pills";
  "aria-label"?: string;
}

export function Tabs<T extends string>({
  items,
  value,
  onChange,
  className,
  size = "md",
  variant = "underline",
  ...rest
}: TabsProps<T>) {
  const listRef = useRef<HTMLDivElement>(null);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) return;
    e.preventDefault();
    const enabled = items.filter((i) => !i.disabled);
    const idx = enabled.findIndex((i) => i.value === value);
    let next = idx;
    if (e.key === "ArrowRight") next = (idx + 1) % enabled.length;
    if (e.key === "ArrowLeft") next = (idx - 1 + enabled.length) % enabled.length;
    if (e.key === "Home") next = 0;
    if (e.key === "End") next = enabled.length - 1;
    const item = enabled[next];
    if (item) {
      onChange(item.value, item);
      const btn = listRef.current?.querySelector<HTMLButtonElement>(`[data-value="${item.value}"]`);
      btn?.focus();
    }
  };

  return (
    <div
      ref={listRef}
      role="tablist"
      aria-label={rest["aria-label"]}
      onKeyDown={onKeyDown}
      className={cn(
        "flex min-w-0 items-end gap-0.5 overflow-x-auto",
        variant === "underline" && "border-b border-border",
        variant === "pills" && "rounded-md bg-surface-2 p-0.5",
        className,
      )}
    >
      {items.map((item) => {
        const selected = item.value === value;
        return (
          <button
            key={item.value}
            role="tab"
            type="button"
            data-value={item.value}
            aria-selected={selected}
            tabIndex={selected ? 0 : -1}
            disabled={item.disabled}
            onClick={() => onChange(item.value, item)}
            className={cn(
              "relative inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap font-medium transition-colors outline-none focus-visible:ring-2 focus-visible:ring-accent/60 disabled:opacity-40",
              size === "sm" ? "h-7 px-2 text-xs" : "h-8 px-2.5 text-[13px]",
              variant === "underline" &&
                cn(
                  "-mb-px rounded-t border-b-2",
                  selected
                    ? "border-accent text-fg"
                    : "border-transparent text-fg-muted hover:border-border-strong hover:text-fg",
                ),
              variant === "pills" &&
                cn(
                  "rounded",
                  selected ? "bg-surface text-fg shadow-sm" : "text-fg-muted hover:text-fg",
                ),
            )}
          >
            {item.tone && <span className={cn("status-dot", item.tone)} aria-hidden />}
            {item.icon}
            {item.label}
            {item.count != null && (
              <span
                className={cn(
                  "num rounded px-1 py-px text-[11px] leading-none",
                  selected ? "bg-surface-3 text-fg" : "bg-surface-2 text-fg-subtle",
                )}
              >
                {formatCompact(item.count)}
              </span>
            )}
            {item.locked && <Lock className="size-3 text-pro" aria-label="Pro feature" />}
          </button>
        );
      })}
    </div>
  );
}
