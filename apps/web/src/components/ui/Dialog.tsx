import { useEffect, useId, useRef, type ReactNode, type MouseEvent } from "react";
import { X } from "lucide-react";
import { cn } from "@/lib/cn";
import { Button } from "./Button";

export interface DialogProps {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  size?: "sm" | "md" | "lg" | "xl";
  /** hide the default close (X) button */
  hideClose?: boolean;
  className?: string;
  bodyClassName?: string;
}

const widths = { sm: "26rem", md: "32rem", lg: "44rem", xl: "60rem" } as const;

/**
 * Native <dialog> based modal. Children are unmounted while closed so form
 * state resets between openings.
 */
export function Dialog({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  size = "md",
  hideClose,
  className,
  bodyClassName,
}: DialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const descId = useId();

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    else if (!open && d.open) d.close();
  }, [open]);

  const onBackdropClick = (e: MouseEvent<HTMLDialogElement>) => {
    if (e.target === ref.current) onClose();
  };

  return (
    <dialog
      ref={ref}
      className={cn("dialog", className)}
      style={{ ["--dialog-w" as string]: widths[size] }}
      aria-labelledby={title ? titleId : undefined}
      aria-describedby={description ? descId : undefined}
      onClose={() => {
        if (open) onClose();
      }}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={onBackdropClick}
    >
      {open && (
        <div className="flex max-h-[90vh] flex-col" onClick={(e) => e.stopPropagation()}>
          {(title || !hideClose) && (
            <header className="flex items-start gap-3 border-b border-border px-5 py-3.5">
              <div className="min-w-0 flex-1">
                {title && (
                  <h2 id={titleId} className="text-sm font-semibold text-fg">
                    {title}
                  </h2>
                )}
                {description && (
                  <p id={descId} className="mt-0.5 text-xs text-fg-muted">
                    {description}
                  </p>
                )}
              </div>
              {!hideClose && (
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Close"
                  onClick={onClose}
                  className="-mr-1.5 -mt-0.5"
                >
                  <X />
                </Button>
              )}
            </header>
          )}
          <div className={cn("min-h-0 flex-1 overflow-y-auto px-5 py-4", bodyClassName)}>{children}</div>
          {footer && (
            <footer className="flex items-center justify-end gap-2 border-t border-border bg-surface-2/50 px-5 py-3">
              {footer}
            </footer>
          )}
        </div>
      )}
    </dialog>
  );
}
