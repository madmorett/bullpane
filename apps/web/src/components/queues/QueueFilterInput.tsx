import { Search, X } from "lucide-react";
import { cn } from "@/lib/cn";
import { Input } from "@/components/ui/Input";

/** `Filter queues…` box shared by the overview and connection pages. Esc clears. */
export function QueueFilterInput({ value, onChange, className, placeholder = "Filter queues…", "aria-label": ariaLabel = "Filter queues by name or connection" }: { value: string; onChange: (v: string) => void; className?: string; placeholder?: string; "aria-label"?: string }) {
  return (
    <div className={cn("relative w-64", className)}>
      <Input leftIcon={<Search />} placeholder={placeholder} value={value} onChange={(e) => onChange(e.target.value)} onKeyDown={(e) => e.key === "Escape" && onChange("")} className="!h-7 pr-7 text-xs" aria-label={ariaLabel} />
      {value && (
        <button type="button" className="absolute top-1/2 right-1.5 -translate-y-1/2 rounded p-0.5 text-fg-subtle hover:text-fg" aria-label="Clear filter" onClick={() => onChange("")}>
          <X className="size-3.5" />
        </button>
      )}
    </div>
  );
}
