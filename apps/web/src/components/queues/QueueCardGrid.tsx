import { Folder as FolderIcon, FolderOpen, Server } from "lucide-react";
import { cn } from "@/lib/cn";
import { entryKey, type QueueEntry, type QueueSection } from "@/lib/groupQueues";
import { QueueCard } from "./QueueCard";

/**
 * bull-board style "squares", grouped in sections (folder / connection / leftovers).
 * `auto-fill` at ~230px puts 5-6 cards per row on a laptop so a dozen queues fit on one screen.
 */
export function QueueCardGrid({
  sections,
  showConnection,
  hideSingleHeader,
  className,
  onHide,
  hidePendingKey,
}: {
  sections: QueueSection[];
  showConnection?: boolean;
  hideSingleHeader?: boolean;
  className?: string;
  /** "Hide from the lists" on each card (operators) */
  onHide?: (entry: QueueEntry) => void;
  hidePendingKey?: string | null;
}) {
  const single = sections.length === 1 && hideSingleHeader;
  return (
    <div className={cn("space-y-4", className)}>
      {sections.map((s) => (
        <section key={s.id} aria-label={s.title}>
          {!single && (
            <h3 className="mb-1.5 flex items-center gap-1.5 text-[11px] font-semibold tracking-wider text-fg-subtle uppercase">
              {s.kind === "folder" ? (
                <FolderIcon className="size-3.5" style={{ color: s.color ?? "var(--fg-subtle)" }} aria-hidden />
              ) : s.kind === "connection" ? (
                <Server className="size-3.5" aria-hidden />
              ) : (
                <FolderOpen className="size-3.5" aria-hidden />
              )}
              <span className="truncate normal-case tracking-normal text-fg-muted">{s.title}</span>
              <span className="num font-normal">{s.items.length}</span>
            </h3>
          )}
          <div className="grid gap-2" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(230px, 1fr))" }}>
            {s.items.map((e) => (
              <QueueCard
                key={`${e.connection.id}/${e.queue.name}`}
                entry={e}
                showConnection={showConnection}
                onHide={onHide}
                hidePending={hidePendingKey === entryKey(e)}
              />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

export function QueueCardSkeleton({ count = 6 }: { count?: number }) {
  return (
    <div className="grid gap-2" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(230px, 1fr))" }}>
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="card h-[118px] animate-pulse" />
      ))}
    </div>
  );
}
