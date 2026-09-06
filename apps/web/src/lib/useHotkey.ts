import { useEffect } from "react";

interface HotkeyOptions {
  /** require Cmd (mac) / Ctrl (others) */
  mod?: boolean;
  /** fire even when focus is inside an input/textarea */
  allowInInputs?: boolean;
  enabled?: boolean;
}

function isEditable(el: Element | null): boolean {
  if (!el) return false;
  const tag = el.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  return (el as HTMLElement).isContentEditable;
}

export function useHotkey(key: string, handler: (e: KeyboardEvent) => void, opts: HotkeyOptions = {}) {
  const { mod = false, allowInInputs = false, enabled = true } = opts;
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() !== key.toLowerCase()) return;
      const wantsMod = e.metaKey || e.ctrlKey;
      if (mod !== wantsMod) return;
      if (!mod && e.altKey) return;
      if (!allowInInputs && isEditable(document.activeElement)) return;
      // ignore while a native dialog is open unless it is a mod shortcut
      if (!mod && document.querySelector("dialog[open]")) return;
      handler(e);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [key, handler, mod, allowInInputs, enabled]);
}

export const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
export const modKeyLabel = isMac ? "⌘" : "Ctrl";
