import type { ReactNode } from "react";
import { cn } from "@/lib/cn";
import { CopyButton } from "./CopyButton";

export interface CodeBlockProps {
  code: string;
  language?: string;
  className?: string;
  /** cap height and scroll */
  maxHeight?: number | string;
  copy?: boolean;
  wrap?: boolean;
  header?: ReactNode;
  tone?: "default" | "danger";
}

export function CodeBlock({ code, language, className, maxHeight = 480, copy = true, wrap, header, tone = "default" }: CodeBlockProps) {
  return (
    <div className={cn("card relative overflow-hidden", tone === "danger" && "border-danger/40", className)}>
      {(header || language || copy) && (
        <div className="flex h-8 items-center justify-between border-b border-border bg-surface-2/60 pr-1 pl-3">
          <span className="text-[11px] tracking-wide text-fg-subtle uppercase">{header ?? language}</span>
          {copy && <CopyButton value={code} size="icon-xs" />}
        </div>
      )}
      <pre
        className={cn(
          "overflow-auto p-3 font-mono text-xs leading-relaxed text-fg",
          wrap ? "break-words whitespace-pre-wrap" : "whitespace-pre",
          tone === "danger" && "text-danger",
        )}
        style={{ maxHeight }}
      >
        <code>{code}</code>
      </pre>
    </div>
  );
}
