import { useEffect, useSyncExternalStore } from "react";
import { AlertTriangle, CheckCircle2, Info, X, XCircle } from "lucide-react";
import { cn } from "@/lib/cn";

export type ToastKind = "info" | "success" | "error" | "warning";

export interface ToastItem {
  id: number;
  kind: ToastKind;
  message: string;
  description?: string;
  durationMs: number;
}

let items: ToastItem[] = [];
let seq = 0;
const listeners = new Set<() => void>();

function emit() {
  listeners.forEach((l) => l());
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}

function push(kind: ToastKind, message: string, opts: { description?: string; durationMs?: number } = {}) {
  // de-dupe identical consecutive toasts
  const dup = items.find((t) => t.message === message && t.kind === kind);
  if (dup) return dup.id;
  const id = ++seq;
  items = [...items, { id, kind, message, description: opts.description, durationMs: opts.durationMs ?? (kind === "error" ? 6000 : 3500) }];
  emit();
  return id;
}

export function dismissToast(id: number) {
  items = items.filter((t) => t.id !== id);
  emit();
}

export const toast = Object.assign(
  (message: string, opts?: { kind?: ToastKind; description?: string; durationMs?: number }) =>
    push(opts?.kind ?? "info", message, opts),
  {
    info: (m: string, d?: string) => push("info", m, { description: d }),
    success: (m: string, d?: string) => push("success", m, { description: d }),
    error: (m: string, d?: string) => push("error", m, { description: d }),
    warning: (m: string, d?: string) => push("warning", m, { description: d }),
  },
);

const icons: Record<ToastKind, typeof Info> = {
  info: Info,
  success: CheckCircle2,
  error: XCircle,
  warning: AlertTriangle,
};
const tones: Record<ToastKind, string> = {
  info: "text-info",
  success: "text-success",
  error: "text-danger",
  warning: "text-warning",
};

function ToastView({ item }: { item: ToastItem }) {
  useEffect(() => {
    const t = setTimeout(() => dismissToast(item.id), item.durationMs);
    return () => clearTimeout(t);
  }, [item.id, item.durationMs]);
  const Icon = icons[item.kind];
  return (
    <div
      role={item.kind === "error" ? "alert" : "status"}
      className="toast-in pointer-events-auto flex w-80 items-start gap-2.5 rounded-lg border border-border bg-surface px-3 py-2.5 text-[13px] shadow-[var(--shadow)]"
    >
      <Icon className={cn("mt-px size-4 shrink-0", tones[item.kind])} aria-hidden />
      <div className="min-w-0 flex-1">
        <p className="text-fg">{item.message}</p>
        {item.description && <p className="mt-0.5 text-xs break-words text-fg-muted">{item.description}</p>}
      </div>
      <button
        type="button"
        aria-label="Dismiss"
        onClick={() => dismissToast(item.id)}
        className="-mr-1 rounded p-0.5 text-fg-subtle hover:text-fg"
      >
        <X className="size-3.5" />
      </button>
    </div>
  );
}

export function Toaster() {
  const list = useSyncExternalStore(subscribe, () => items, () => items);
  if (list.length === 0) return null;
  return (
    <div className="pointer-events-none fixed right-4 bottom-4 z-[100] flex flex-col items-end gap-2" aria-live="polite">
      {list.map((t) => (
        <ToastView key={t.id} item={t} />
      ))}
    </div>
  );
}
