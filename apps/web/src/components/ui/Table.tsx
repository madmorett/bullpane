import type { HTMLAttributes, TdHTMLAttributes, ThHTMLAttributes, KeyboardEvent } from "react";
import { cn } from "@/lib/cn";

export interface TableProps extends HTMLAttributes<HTMLTableElement> {
  dense?: boolean;
  wrapperClassName?: string;
  /** max height with sticky header */
  maxHeight?: string | number;
}

export function Table({ dense, className, wrapperClassName, maxHeight, children, ...rest }: TableProps) {
  return (
    <div
      className={cn("table-wrap", maxHeight != null && "overflow-y-auto", wrapperClassName)}
      style={maxHeight != null ? { maxHeight } : undefined}
    >
      <table className={cn("data-table", dense && "dense", className)} {...rest}>
        {children}
      </table>
    </div>
  );
}

export interface ThProps extends ThHTMLAttributes<HTMLTableCellElement> {
  align?: "left" | "right" | "center";
}
export function Th({ align = "left", className, ...rest }: ThProps) {
  return (
    <th
      scope="col"
      className={cn(align === "right" && "!text-right", align === "center" && "!text-center", className)}
      {...rest}
    />
  );
}

export interface TdProps extends TdHTMLAttributes<HTMLTableCellElement> {
  align?: "left" | "right" | "center";
  num?: boolean;
  mono?: boolean;
  muted?: boolean;
}
export function Td({ align = "left", num, mono, muted, className, ...rest }: TdProps) {
  return (
    <td
      className={cn(
        align === "right" && "text-right",
        align === "center" && "text-center",
        num && "num",
        mono && "font-mono text-xs",
        muted && "text-fg-muted",
        className,
      )}
      {...rest}
    />
  );
}

export interface TrProps extends HTMLAttributes<HTMLTableRowElement> {
  /** makes the row focusable and activatable with Enter / Space */
  onActivate?: () => void;
  selected?: boolean;
}
export function Tr({ onActivate, selected, className, onClick, onKeyDown, ...rest }: TrProps) {
  const clickable = !!onActivate;
  return (
    <tr
      tabIndex={clickable ? 0 : undefined}
      aria-selected={selected || undefined}
      className={cn(clickable && "row-click", selected && "bg-accent/10", className)}
      onClick={(e) => {
        onClick?.(e);
        if (!clickable || e.defaultPrevented) return;
        // ignore clicks on interactive children
        const target = e.target as HTMLElement;
        if (target.closest("button, a, input, select, textarea, [data-no-row-click]")) return;
        onActivate?.();
      }}
      onKeyDown={(e: KeyboardEvent<HTMLTableRowElement>) => {
        onKeyDown?.(e);
        if (!clickable || e.defaultPrevented) return;
        if (e.target !== e.currentTarget) return;
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onActivate?.();
        }
      }}
      {...rest}
    />
  );
}

export function TableMessage({
  colSpan,
  children,
  className,
}: {
  colSpan: number;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <tr>
      <td colSpan={colSpan} className={cn("!py-10 text-center text-fg-subtle", className)}>
        {children}
      </td>
    </tr>
  );
}
