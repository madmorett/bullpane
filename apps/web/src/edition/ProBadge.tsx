import { Lock } from "lucide-react";
import { cn } from "@/lib/cn";
import { useEdition } from "./useEdition";
import { Badge } from "@/components/ui/Badge";

/** Edition pill: PRO / DEMO / FREE. */
export function EditionPill({ className }: { className?: string }) {
  const { isPro, demo } = useEdition();
  if (demo) {
    return (
      <Badge variant="warning" size="xs" className={cn("tracking-wider", className)} title="Demo mode: Pro unlocked, settings locked">
        DEMO
      </Badge>
    );
  }
  if (isPro) {
    return (
      <Badge variant="pro" size="xs" className={cn("tracking-wider", className)}>
        PRO
      </Badge>
    );
  }
  return (
    <Badge variant="outline" size="xs" className={cn("tracking-wider", className)}>
      FREE
    </Badge>
  );
}

/** Small "PRO" marker for locked / pro-only things. */
export function ProBadge({ className, locked }: { className?: string; locked?: boolean }) {
  return (
    <Badge variant="pro" size="xs" className={cn("tracking-wider", className)} title="Pro feature">
      {locked && <Lock className="size-2.5" aria-hidden />}
      PRO
    </Badge>
  );
}

export function LockIcon({ className }: { className?: string }) {
  return <Lock className={cn("size-3 shrink-0 text-pro", className)} aria-label="Pro feature" />;
}
