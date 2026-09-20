import { useEffect, useState, type ReactNode } from "react";
import { Check, Copy } from "lucide-react";
import { Button, type ButtonProps } from "./Button";

export interface CopyButtonProps extends Omit<ButtonProps, "onClick" | "children" | "value"> {
  value: string | (() => string);
  label?: string;
  copiedLabel?: string;
  /** show text next to the icon */
  showLabel?: boolean;
  /** icon to show instead of the clipboard; two clipboard icons side by side are indistinguishable */
  icon?: ReactNode;
}

export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      document.body.removeChild(ta);
      return ok;
    } catch {
      return false;
    }
  }
}

export function CopyButton({
  value,
  label = "Copy",
  copiedLabel = "Copied",
  showLabel,
  icon,
  variant = "ghost",
  size,
  ...rest
}: CopyButtonProps) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(t);
  }, [copied]);
  return (
    <Button
      variant={variant}
      size={size ?? (showLabel ? "sm" : "icon-sm")}
      aria-label={copied ? copiedLabel : label}
      title={copied ? copiedLabel : label}
      onClick={async () => {
        const ok = await copyToClipboard(typeof value === "function" ? value() : value);
        if (ok) setCopied(true);
      }}
      {...rest}
    >
      {copied ? <Check className="text-success" /> : (icon ?? <Copy />)}
      {showLabel && (copied ? copiedLabel : label)}
    </Button>
  );
}
