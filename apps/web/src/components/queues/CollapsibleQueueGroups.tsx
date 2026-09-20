import { ChevronDown, ChevronRight, Folder as FolderIcon, FolderOpen, Server } from "lucide-react";
import { cn } from "@/lib/cn";
import { formatCompact } from "@/lib/format";
import { totals, type QueueSection } from "@/lib/groupQueues";
import { usePersistedToggle } from "@/lib/usePersistedToggle";
import { STATE_COLORS, type ColoredState } from "@/lib/stateColors";
import { QueueCard } from "./QueueCard";

/**
 * The rest of the queues, one collapsible block per connection (or folder).
 *
 * Collapsed, a block is a single row that still carries the numbers that matter
 * — queue count, waiting, active, failed — so ten connections are ten rows a
 * user can read at once instead of ten screens of cards. Expanding one shows its
 * cards. The choice is remembered per section in localStorage.
 */
export function CollapsibleQueueGroups({
  sections,
  showConnection,
  defaultOpen,
  storagePrefix = "overview.group",
  className,
}: {
  sections: QueueSection[];
  showConnection?: boolean;
  /** with one or two connections there is nothing to protect the page from, so start open */
  defaultOpen: boolean;
  storagePrefix?: string;
  className?: string;
}) {
  if (sections.length === 0) return null;
  return (
    <div className={cn("space-y-1.5", className)}>
      {sections.map((s) => (
        <Group key={s.id} section={s} showConnection={showConnection} defaultOpen={defaultOpen} storagePrefix={storagePrefix} />
      ))}
    </div>
  );
}

function Group({
  section,
  showConnection,
  defaultOpen,
  storagePrefix,
}: {
  section: QueueSection;
  showConnection?: boolean;
  defaultOpen: boolean;
  storagePrefix: string;
}) {
  const [open, toggle] = usePersistedToggle(`${storagePrefix}.${section.id}`, defaultOpen);
  const sums = totals(section.items);

  const Icon = section.kind === "folder" ? FolderIcon : section.kind === "connection" ? Server : FolderOpen;

  return (
    <section className="card overflow-hidden" aria-label={section.title}>
      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        className={cn(
          "flex w-full flex-wrap items-center gap-x-4 gap-y-1 px-3 py-2 text-left transition-colors hover:bg-surface-2",
          open && "border-b border-border",
        )}
      >
        {open ? <ChevronDown className="size-3.5 shrink-0 text-fg-subtle" aria-hidden /> : <ChevronRight className="size-3.5 shrink-0 text-fg-subtle" aria-hidden />}
        <Icon className="size-3.5 shrink-0" style={{ color: section.color ?? "var(--fg-subtle)" }} aria-hidden />

        <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-fg" title={section.title}>
          {section.title}
        </span>

        <span className="num shrink-0 text-xs text-fg-subtle">
          {sums.queues} {sums.queues === 1 ? "queue" : "queues"}
          {sums.paused > 0 && <span className="text-state-paused"> · {sums.paused} paused</span>}
        </span>

        <span className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-0.5">
          <Mini state="waiting" value={sums.waiting} />
          <Mini state="active" value={sums.active} />
          <Mini state="failed" value={sums.failed} dimZero />
        </span>
      </button>

      {open && (
        <div className="grid gap-2 p-2" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(230px, 1fr))" }}>
          {section.items.map((e) => (
            <QueueCard key={`${e.connection.id}/${e.queue.name}`} entry={e} showConnection={showConnection} />
          ))}
        </div>
      )}
    </section>
  );
}

function Mini({ state, value, dimZero }: { state: ColoredState; value: number; dimZero?: boolean }) {
  const c = STATE_COLORS[state];
  const dim = dimZero && value === 0;
  return (
    <span className="flex items-baseline gap-1" title={`${value} ${c.label}`}>
      <span className={cn("status-dot size-1.5 self-center", c.dotClass, dim && "opacity-40")} aria-hidden />
      <span className={cn("num text-xs font-medium", dim ? "text-fg-subtle" : c.textClass)}>{formatCompact(value)}</span>
      <span className="text-[10px] text-fg-subtle">{c.label}</span>
    </span>
  );
}
