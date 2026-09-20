import type { ReactNode } from "react";
import { Logo } from "@/components/layout/Sidebar";
import { EditionPill } from "@/edition/ProBadge";

export function AuthLayout({ title, description, children, footer }: { title: string; description?: ReactNode; children: ReactNode; footer?: ReactNode }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-bg px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex items-center justify-center gap-2">
          <Logo className="size-8" />
          <span className="text-base font-semibold tracking-tight">Bullpane</span>
          <EditionPill />
        </div>
        <div className="card p-6 shadow-[var(--shadow)]">
          <h1 className="text-base font-semibold text-fg">{title}</h1>
          {description && <p className="mt-1 text-xs text-fg-muted">{description}</p>}
          <div className="mt-5">{children}</div>
        </div>
        {footer && <div className="mt-4 text-center text-xs text-fg-subtle">{footer}</div>}
      </div>
    </div>
  );
}
