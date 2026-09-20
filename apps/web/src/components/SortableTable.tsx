import { useMemo, type ReactNode } from "react";
import { ArrowDown, ArrowUp, ArrowUpDown } from "lucide-react";
import { cn } from "@/lib/cn";
import type { SortDir, SortState } from "@/lib/useTableState";
import { Table, TableMessage, Td, Th, Tr, type TableProps } from "@/components/ui/Table";

export type SortValue = string | number | boolean | null | undefined;

export interface SortableColumn<T> {
  /** stable id; also the value written to `?sort=` */
  key: string;
  header: ReactNode;
  align?: "left" | "right" | "center";
  /** value to sort by; omit to make the column unsortable */
  sortValue?: (row: T) => SortValue;
  render: (row: T) => ReactNode;
  /** direction used the first time the header is clicked */
  defaultDir?: SortDir;
  className?: string;
  thClassName?: string;
  /** cell modifiers forwarded to <Td> */
  num?: boolean;
  mono?: boolean;
  muted?: boolean | ((row: T) => boolean);
  /** stops row activation when clicking inside the cell */
  noRowClick?: boolean;
}

export interface SortableTableProps<T> extends Omit<TableProps, "children"> {
  columns: SortableColumn<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  sort: SortState;
  onSort: (next: SortState) => void;
  onRowActivate?: (row: T) => void;
  rowClassName?: (row: T) => string | undefined;
  /** rendered in a single full-width row when there is nothing else to show */
  message?: ReactNode;
  messageClassName?: string;
  /** skip sorting (e.g. the caller already sorted) */
  presorted?: boolean;
}

/** Compare two sort values: numbers numerically, strings with localeCompare, null/undefined last. */
export function compareSortValues(a: SortValue, b: SortValue): number {
  const an = a == null || a === "";
  const bn = b == null || b === "";
  if (an && bn) return 0;
  if (an) return 1;
  if (bn) return -1;
  if (typeof a === "number" && typeof b === "number") return a - b;
  if (typeof a === "boolean" && typeof b === "boolean") return Number(a) - Number(b);
  const as = String(a);
  const bs = String(b);
  const na = Number(as);
  const nb = Number(bs);
  if (as.trim() !== "" && bs.trim() !== "" && !Number.isNaN(na) && !Number.isNaN(nb)) return na - nb;
  return as.localeCompare(bs, undefined, { numeric: true, sensitivity: "base" });
}

/** Stable sort: equal keys keep their input order. */
export function sortRows<T>(rows: T[], columns: SortableColumn<T>[], sort: SortState): T[] {
  const col = columns.find((c) => c.key === sort.key && c.sortValue);
  if (!col) return rows;
  const get = col.sortValue!;
  const mult = sort.dir === "asc" ? 1 : -1;
  return rows
    .map((row, i) => ({ row, i, v: get(row) }))
    .sort((x, y) => {
      const c = compareSortValues(x.v, y.v);
      // null/undefined stay last regardless of direction
      if (c !== 0 && (x.v == null || y.v == null || x.v === "" || y.v === "")) return c;
      return c !== 0 ? c * mult : x.i - y.i;
    })
    .map((x) => x.row);
}

export function SortableTable<T>({
  columns,
  rows,
  rowKey,
  sort,
  onSort,
  onRowActivate,
  rowClassName,
  message,
  messageClassName,
  presorted,
  className,
  ...tableProps
}: SortableTableProps<T>) {
  const sorted = useMemo(() => (presorted ? rows : sortRows(rows, columns, sort)), [rows, columns, sort, presorted]);

  const toggle = (col: SortableColumn<T>) => {
    if (!col.sortValue) return;
    if (sort.key === col.key) onSort({ key: col.key, dir: sort.dir === "asc" ? "desc" : "asc" });
    else onSort({ key: col.key, dir: col.defaultDir ?? (col.num || col.align === "right" ? "desc" : "asc") });
  };

  return (
    <Table className={className} {...tableProps}>
      <thead>
        <tr>
          {columns.map((col) => {
            const active = sort.key === col.key && !!col.sortValue;
            const ariaSort = active ? (sort.dir === "asc" ? "ascending" : "descending") : col.sortValue ? "none" : undefined;
            return (
              <Th key={col.key} align={col.align} className={cn(col.thClassName, active && "!text-fg")} aria-sort={ariaSort}>
                {col.sortValue ? (
                  <button type="button" className={cn("sort-header", col.align === "right" && "flex-row-reverse")} onClick={() => toggle(col)} title={`Sort by ${typeof col.header === "string" ? col.header : col.key}`}>
                    <span>{col.header}</span>
                    {active ? sort.dir === "asc" ? <ArrowUp className="size-3" aria-hidden /> : <ArrowDown className="size-3" aria-hidden /> : <ArrowUpDown className="size-3 opacity-40" aria-hidden />}
                  </button>
                ) : (
                  col.header
                )}
              </Th>
            );
          })}
        </tr>
      </thead>
      <tbody>
        {message != null && sorted.length === 0 && (
          <TableMessage colSpan={columns.length} className={messageClassName}>
            {message}
          </TableMessage>
        )}
        {sorted.map((row) => (
          <Tr key={rowKey(row)} onActivate={onRowActivate ? () => onRowActivate(row) : undefined} className={rowClassName?.(row)}>
            {columns.map((col) => (
              <Td
                key={col.key}
                align={col.align}
                num={col.num}
                mono={col.mono}
                muted={typeof col.muted === "function" ? col.muted(row) : col.muted}
                className={col.className}
                data-no-row-click={col.noRowClick ? true : undefined}
              >
                {col.render(row)}
              </Td>
            ))}
          </Tr>
        ))}
      </tbody>
    </Table>
  );
}
