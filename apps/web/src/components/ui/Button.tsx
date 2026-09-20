import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import { Loader2 } from "lucide-react";
import { cn } from "@/lib/cn";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "outline" | "danger" | "link";
export type ButtonSize = "xs" | "sm" | "md" | "icon" | "icon-sm" | "icon-xs";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  leftIcon?: ReactNode;
  rightIcon?: ReactNode;
}

const variants: Record<ButtonVariant, string> = {
  primary: "bg-accent text-accent-fg hover:bg-accent-hover border border-transparent",
  secondary: "bg-surface-2 text-fg border border-border hover:bg-surface-3 hover:border-border-strong",
  outline: "bg-transparent text-fg border border-border-strong hover:bg-surface-2",
  ghost: "bg-transparent text-fg-muted border border-transparent hover:text-fg hover:bg-surface-2",
  danger: "bg-danger/90 text-white border border-transparent hover:bg-danger",
  link: "bg-transparent text-accent border border-transparent hover:underline px-0 h-auto",
};

const sizes: Record<ButtonSize, string> = {
  xs: "h-6 px-2 text-[11px] gap-1 [&_svg]:size-3",
  sm: "h-7 px-2.5 text-xs gap-1.5 [&_svg]:size-3.5",
  md: "h-8 px-3 text-[13px] gap-1.5 [&_svg]:size-4",
  icon: "h-8 w-8 [&_svg]:size-4",
  "icon-sm": "h-7 w-7 [&_svg]:size-3.5",
  "icon-xs": "h-6 w-6 [&_svg]:size-3",
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "secondary", size = "md", loading, leftIcon, rightIcon, className, children, disabled, type = "button", ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      disabled={disabled || loading}
      className={cn(
        "inline-flex shrink-0 select-none items-center justify-center rounded-md font-medium whitespace-nowrap transition-colors outline-none",
        "focus-visible:ring-2 focus-visible:ring-accent/60 disabled:pointer-events-none disabled:opacity-50",
        variants[variant],
        sizes[size],
        className,
      )}
      {...rest}
    >
      {loading ? <Loader2 className="animate-spin" aria-hidden /> : leftIcon}
      {children}
      {!loading && rightIcon}
    </button>
  );
});
