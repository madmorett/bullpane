import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

export interface TooltipProps {
  content: ReactNode;
  children: ReactNode;
  side?: "top" | "bottom" | "left" | "right";
  className?: string;
  /** render as block (full width) instead of inline-flex */
  block?: boolean;
}

/**
 * CSS-only tooltip: shows on hover and on focus within. Cheap, no portal.
 */
export function Tooltip({ content, children, side = "top", className, block }: TooltipProps) {
  if (content == null || content === "") return <>{children}</>;
  const pos = {
    top: "bottom-full left-1/2 mb-1.5 -translate-x-1/2",
    bottom: "top-full left-1/2 mt-1.5 -translate-x-1/2",
    left: "right-full top-1/2 mr-1.5 -translate-y-1/2",
    right: "left-full top-1/2 ml-1.5 -translate-y-1/2",
  }[side];
  return (
    <span className={cn("has-tooltip relative", block ? "block" : "inline-flex", className)}>
      {children}
      <span role="tooltip" className={cn("tooltip", pos)}>
        {content}
      </span>
    </span>
  );
}
