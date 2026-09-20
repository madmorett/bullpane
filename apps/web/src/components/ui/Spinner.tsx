import { Loader2 } from "lucide-react";
import { cn } from "@/lib/cn";

export function Spinner({ className, size = 16, label }: { className?: string; size?: number; label?: string }) {
  return (
    <span role="status" aria-label={label ?? "Loading"} className={cn("inline-flex items-center gap-2 text-fg-subtle", className)}>
      <Loader2 className="animate-spin" style={{ width: size, height: size }} aria-hidden />
      {label && <span className="text-xs">{label}</span>}
    </span>
  );
}

export function PageSpinner({ label = "Loading…" }: { label?: string }) {
  return (
    <div className="flex h-48 w-full items-center justify-center">
      <Spinner size={18} label={label} />
    </div>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <span className={cn("skeleton inline-block h-3 w-16 align-middle", className)} aria-hidden />;
}
