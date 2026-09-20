import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

export interface EmptyStateProps {
  icon?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  className?: string;
  compact?: boolean;
}

export function EmptyState({ icon, title, description, action, className, compact }: EmptyStateProps) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center text-center",
        compact ? "gap-2 px-4 py-8" : "gap-3 px-6 py-16",
        className,
      )}
    >
      {icon && (
        <div className="flex size-10 items-center justify-center rounded-lg border border-border bg-surface-2 text-fg-subtle [&_svg]:size-5">
          {icon}
        </div>
      )}
      <div className="max-w-sm">
        <h3 className="text-sm font-semibold text-fg">{title}</h3>
        {description && <p className="mt-1 text-xs leading-relaxed text-fg-muted">{description}</p>}
      </div>
      {action && <div className="mt-1 flex items-center gap-2">{action}</div>}
    </div>
  );
}
