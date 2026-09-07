import type { ConnectionStatus } from "@bullpane/shared";
import { cn } from "@/lib/cn";
import { Tooltip } from "@/components/ui/Tooltip";
import { formatRelative } from "@/lib/format";

export function statusTone(status: ConnectionStatus | undefined | null): "ok" | "down" | "unknown" {
  if (!status) return "unknown";
  return status.ok ? "ok" : "down";
}

export function ConnectionStatusDot({
  status,
  className,
  pulse,
  withLabel,
}: {
  status: ConnectionStatus | undefined | null;
  className?: string;
  pulse?: boolean;
  withLabel?: boolean;
}) {
  const tone = statusTone(status);
  const color = tone === "ok" ? "bg-success text-success" : tone === "down" ? "bg-danger text-danger" : "bg-fg-subtle text-fg-subtle";
  const label =
    tone === "ok"
      ? `Connected · ${status?.latencyMs ?? "?"} ms · Redis ${status?.redisVersion ?? "?"}`
      : tone === "down"
        ? `Down: ${status?.error ?? "unreachable"}`
        : "Status unknown";
  const checked = status?.checkedAt ? ` · checked ${formatRelative(status.checkedAt)}` : "";
  return (
    <Tooltip content={label + checked}>
      <span className={cn("inline-flex items-center gap-1.5", className)}>
        <span className={cn("status-dot", color, pulse && tone === "down" && "pulse")} aria-label={label} role="img" />
        {withLabel && (
          <span className={cn("text-xs", tone === "down" ? "text-danger" : "text-fg-muted")}>
            {tone === "ok" ? "Connected" : tone === "down" ? "Down" : "Unknown"}
          </span>
        )}
      </span>
    </Tooltip>
  );
}
