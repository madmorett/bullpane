import { useState, type ReactNode } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { cn } from "@/lib/cn";

export interface JsonViewProps {
  value: unknown;
  /** how many levels open by default */
  defaultExpandDepth?: number;
  className?: string;
  /** label shown before the root value */
  name?: string;
}

/**
 * Collapsible JSON tree. No dependencies. Primitives are colour coded,
 * long strings are clipped with click-to-expand.
 */
export function JsonView({ value, defaultExpandDepth = 2, className, name }: JsonViewProps) {
  return (
    <div className={cn("font-mono text-xs leading-[1.6] text-fg", className)}>
      <Node name={name} value={value} depth={0} expandDepth={defaultExpandDepth} last />
    </div>
  );
}

type Kind = "object" | "array" | "string" | "number" | "boolean" | "null" | "undefined" | "other";

function kindOf(v: unknown): Kind {
  if (v === null) return "null";
  if (v === undefined) return "undefined";
  if (Array.isArray(v)) return "array";
  const t = typeof v;
  if (t === "object") return "object";
  if (t === "string") return "string";
  if (t === "number" || t === "bigint") return "number";
  if (t === "boolean") return "boolean";
  return "other";
}

const MAX_STRING = 200;

function Primitive({ value }: { value: unknown }) {
  const [expanded, setExpanded] = useState(false);
  const kind = kindOf(value);
  switch (kind) {
    case "string": {
      const s = value as string;
      const clipped = !expanded && s.length > MAX_STRING;
      const shown = clipped ? `${s.slice(0, MAX_STRING)}…` : s;
      return (
        <span className="text-success break-all">
          "{shown}"
          {s.length > MAX_STRING && (
            <button
              type="button"
              className="ml-1 rounded bg-surface-3 px-1 text-[10px] text-fg-muted hover:text-fg"
              onClick={() => setExpanded((e) => !e)}
            >
              {expanded ? "less" : `+${s.length - MAX_STRING} chars`}
            </button>
          )}
        </span>
      );
    }
    case "number":
      return <span className="text-info">{String(value)}</span>;
    case "boolean":
      return <span className="text-violet">{String(value)}</span>;
    case "null":
      return <span className="text-fg-subtle">null</span>;
    case "undefined":
      return <span className="text-fg-subtle">undefined</span>;
    default:
      return <span className="text-fg-muted">{String(value)}</span>;
  }
}

interface NodeProps {
  name?: string;
  value: unknown;
  depth: number;
  expandDepth: number;
  last: boolean;
}

function Node({ name, value, depth, expandDepth, last }: NodeProps) {
  const kind = kindOf(value);
  const isContainer = kind === "object" || kind === "array";
  const [open, setOpen] = useState(depth < expandDepth);

  const label: ReactNode =
    name !== undefined ? (
      <>
        <span className="text-fg">{isIdentifier(name) ? name : JSON.stringify(name)}</span>
        <span className="text-fg-subtle">: </span>
      </>
    ) : null;

  if (!isContainer) {
    return (
      <div className="flex" style={{ paddingLeft: depth ? 16 : 0 }}>
        <span className="w-4 shrink-0" />
        <span className="min-w-0">
          {label}
          <Primitive value={value} />
          {!last && <span className="text-fg-subtle">,</span>}
        </span>
      </div>
    );
  }

  const entries: [string, unknown][] =
    kind === "array"
      ? (value as unknown[]).map((v, i) => [String(i), v])
      : Object.entries(value as Record<string, unknown>);
  const [openB, closeB] = kind === "array" ? ["[", "]"] : ["{", "}"];
  const summary = kind === "array" ? `${entries.length} item${entries.length === 1 ? "" : "s"}` : `${entries.length} key${entries.length === 1 ? "" : "s"}`;

  if (entries.length === 0) {
    return (
      <div className="flex" style={{ paddingLeft: depth ? 16 : 0 }}>
        <span className="w-4 shrink-0" />
        <span>
          {label}
          <span className="text-fg-muted">
            {openB}
            {closeB}
          </span>
          {!last && <span className="text-fg-subtle">,</span>}
        </span>
      </div>
    );
  }

  return (
    <div style={{ paddingLeft: depth ? 16 : 0 }}>
      <div className="flex">
        <button
          type="button"
          aria-expanded={open}
          aria-label={open ? "Collapse" : "Expand"}
          onClick={() => setOpen((o) => !o)}
          className="flex w-4 shrink-0 items-start justify-center pt-[3px] text-fg-subtle hover:text-fg"
        >
          {open ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
        </button>
        <span className="min-w-0 cursor-default" onClick={() => !open && setOpen(true)}>
          {label}
          <span className="text-fg-muted">{openB}</span>
          {!open && (
            <>
              <span className="mx-1 rounded bg-surface-3 px-1 text-[10px] text-fg-subtle">{summary}</span>
              <span className="text-fg-muted">{closeB}</span>
              {!last && <span className="text-fg-subtle">,</span>}
            </>
          )}
        </span>
      </div>
      {open && (
        <>
          <div className="border-l border-border/70" style={{ marginLeft: 7 }}>
            {entries.map(([k, v], i) => (
              <Node
                key={k}
                name={kind === "array" ? undefined : k}
                value={v}
                depth={depth + 1}
                expandDepth={expandDepth}
                last={i === entries.length - 1}
              />
            ))}
          </div>
          <div className="flex">
            <span className="w-4 shrink-0" />
            <span className="text-fg-muted">
              {closeB}
              {!last && <span className="text-fg-subtle">,</span>}
            </span>
          </div>
        </>
      )}
    </div>
  );
}

function isIdentifier(s: string): boolean {
  return /^[A-Za-z_$][\w$]*$/.test(s);
}
