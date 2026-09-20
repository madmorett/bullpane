import { ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Select } from "@/components/ui/Input";
import { formatNumber } from "@/lib/format";

export const PAGE_SIZES = [25, 50, 100, 200] as const;

export interface PaginationProps {
  page: number;
  pageSize: number;
  total: number;
  onPage: (page: number) => void;
  onPageSize?: (size: number) => void;
  /** items on the current page (for "x–y of z") */
  count?: number;
  className?: string;
}

export function Pagination({ page, pageSize, total, onPage, onPageSize, count, className }: PaginationProps) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const start = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const end = count != null ? start + Math.max(0, count - 1) : Math.min(total, page * pageSize);
  return (
    <div className={`flex flex-wrap items-center justify-between gap-3 text-xs text-fg-muted ${className ?? ""}`}>
      <div className="flex items-center gap-2">
        <span className="num">
          {total === 0 ? "0 items" : `${formatNumber(start)}–${formatNumber(end)} of ${formatNumber(total)}`}
        </span>
        {onPageSize && (
          <label className="flex items-center gap-1.5">
            <span className="sr-only">Page size</span>
            <Select
              aria-label="Page size"
              className="!h-7 !w-auto !py-0 text-xs"
              value={String(pageSize)}
              onChange={(e) => onPageSize(Number(e.target.value))}
              options={PAGE_SIZES.map((s) => ({ value: String(s), label: `${s} / page` }))}
            />
          </label>
        )}
      </div>
      <div className="flex items-center gap-1">
        <Button size="icon-sm" variant="ghost" aria-label="First page" disabled={page <= 1} onClick={() => onPage(1)}>
          <ChevronsLeft />
        </Button>
        <Button size="icon-sm" variant="ghost" aria-label="Previous page" disabled={page <= 1} onClick={() => onPage(page - 1)}>
          <ChevronLeft />
        </Button>
        <span className="num min-w-16 text-center">
          {page} / {pages}
        </span>
        <Button size="icon-sm" variant="ghost" aria-label="Next page" disabled={page >= pages} onClick={() => onPage(page + 1)}>
          <ChevronRight />
        </Button>
        <Button size="icon-sm" variant="ghost" aria-label="Last page" disabled={page >= pages} onClick={() => onPage(pages)}>
          <ChevronsRight />
        </Button>
      </div>
    </div>
  );
}
