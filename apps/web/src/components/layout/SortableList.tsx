import { createContext, useContext, type CSSProperties, type KeyboardEvent, type ReactNode } from "react";
import { DndContext, MouseSensor, TouchSensor, closestCenter, pointerWithin, useSensor, useSensors, type CollisionDetection, type Modifier } from "@dnd-kit/core";
import { SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";

type OnMove = (dragged: string, target: string) => void;

const ListContext = createContext<{ ids: string[]; onMove: OnMove } | null>(null);

const verticalOnly: Modifier = ({ transform }) => ({ ...transform, x: 0 });

/**
 * The row under the pointer wins. closestCenter alone compares the dragged
 * item's centre, and an expanded connection is hundreds of pixels tall, so it
 * could not reach the top of the list. Falls back to it between rows.
 */
const underPointer: CollisionDetection = (args) => {
  const hits = pointerWithin(args);
  return hits.length ? hits : closestCenter(args);
};

/**
 * dnd-kit's click guard only stops propagation, so React Router never sees the
 * click but the browser still follows the <a>'s href: a full page load after
 * every drop. Swallow the one click that follows a drag.
 */
function swallowNextClick() {
  const block = (e: MouseEvent) => e.preventDefault();
  window.addEventListener("click", block, { capture: true, once: true });
  setTimeout(() => window.removeEventListener("click", block, { capture: true }), 0);
}

/**
 * One reorderable list of the sidebar. Each list is its own DndContext, so a
 * queue can only land among its siblings, never among folders.
 *
 * No KeyboardSensor: it starts a drag on Enter/Space, which on these rows
 * would hijack opening the link. Alt+↑/↓ (useSortableRow) moves instead.
 */
export function SortableList({ ids, onMove, children }: { ids: string[]; onMove: OnMove; children: ReactNode }) {
  const sensors = useSensors(
    // A few pixels before it counts as a drag, so a click is still a click.
    useSensor(MouseSensor, { activationConstraint: { distance: 4 } }),
    // Press and hold on touch, so a swipe still scrolls the sidebar.
    useSensor(TouchSensor, { activationConstraint: { delay: 250, tolerance: 5 } }),
  );
  return (
    <ListContext.Provider value={{ ids, onMove }}>
      <DndContext
        sensors={sensors}
        collisionDetection={underPointer}
        modifiers={[verticalOnly]}
        onDragEnd={({ active, over }) => {
          swallowNextClick();
          if (over && active.id !== over.id) onMove(String(active.id), String(over.id));
        }}
      >
        <SortableContext items={ids} strategy={verticalListSortingStrategy}>
          {children}
        </SortableContext>
      </DndContext>
    </ListContext.Provider>
  );
}

export interface SortableRow {
  /** on the element that moves (a folder with its children, a queue row) */
  node: { ref: (el: HTMLElement | null) => void; style: CSSProperties; "data-dragging"?: true };
  /** on the part you grab (a folder's header, the queue row itself) */
  handle: Record<string, unknown>;
}

export function useSortableRow(id: string): SortableRow {
  const list = useContext(ListContext);
  const { setNodeRef, listeners, transform, transition, isDragging } = useSortable({ id });
  return {
    node: {
      ref: setNodeRef,
      style: {
        transform: transform ? `translate3d(0, ${Math.round(transform.y)}px, 0)` : undefined,
        transition,
        position: "relative",
        zIndex: isDragging ? 10 : undefined,
      },
      "data-dragging": isDragging || undefined,
    },
    handle: {
      ...listeners,
      onKeyDown: (e: KeyboardEvent) => {
        if (!list || !e.altKey || (e.key !== "ArrowUp" && e.key !== "ArrowDown")) return;
        const target = list.ids[list.ids.indexOf(id) + (e.key === "ArrowUp" ? -1 : 1)];
        if (target === undefined) return;
        e.preventDefault();
        e.stopPropagation();
        list.onMove(id, target);
      },
    },
  };
}
