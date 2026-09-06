import type { HTMLAttributes, ReactNode } from "react";
import { cn } from "@/lib/cn";

export type BadgeVariant =
  | "neutral"
  | "outline"
  | "success"
  | "warning"
  | "danger"
  | "info"
  | "accent"
  | "violet"
  | "teal"
  | "pro"
  /** no colour classes; caller supplies them via className / style */
  | "custom";

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  variant?: BadgeVariant;
  dot?: boolean;
  size?: "xs" | "sm";
  mono?: boolean;
  children?: ReactNode;
}

const styles: Record<BadgeVariant, string> = {
  neutral: "bg-surface-3 text-fg-muted",
  outline: "border border-border-strong text-fg-muted",
  success: "bg-success/15 text-success",
  warning: "bg-warning/15 text-warning",
  danger: "bg-danger/15 text-danger",
  info: "bg-info/15 text-info",
  accent: "bg-accent/15 text-accent",
  violet: "bg-violet/15 text-violet",
  teal: "bg-teal/15 text-teal",
  pro: "bg-pro/15 text-pro",
  custom: "",
};

export function Badge({ variant = "neutral", dot, size = "sm", mono, className, children, ...rest }: BadgeProps) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1 rounded font-medium whitespace-nowrap",
        size === "xs" ? "h-4 px-1 text-[10px] leading-none" : "h-5 px-1.5 text-[11px] leading-none",
        mono && "font-mono",
        styles[variant],
        className,
      )}
      {...rest}
    >
      {dot && <span className="status-dot size-1.5 bg-current" aria-hidden />}
      {children}
    </span>
  );
}
