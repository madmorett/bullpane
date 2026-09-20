import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

export function Kbd({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <kbd
      className={cn(
        "inline-flex h-5 min-w-5 items-center justify-center rounded border border-border-strong bg-surface-2 px-1 font-mono text-[10px] leading-none text-fg-muted shadow-[inset_0_-1px_0_var(--border-strong)]",
        className,
      )}
    >
      {children}
    </kbd>
  );
}
