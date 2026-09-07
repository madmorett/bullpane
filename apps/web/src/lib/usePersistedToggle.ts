import { useCallback, useState } from "react";
import { readStorage, writeStorage } from "./storage";

/**
 * A boolean that remembers itself in localStorage under `bmv.<key>`.
 *
 * `defaultOpen` is only consulted the FIRST time a key is seen: once the user
 * has expanded or collapsed something we honour that choice even if the
 * heuristic default later flips (e.g. an 11th connection is added and the page
 * would otherwise start collapsing groups the user had opened).
 */
export function usePersistedToggle(key: string, defaultOpen: boolean): [boolean, () => void, (next: boolean) => void] {
  const [open, setOpenState] = useState<boolean>(() => readStorage<boolean>(key, defaultOpen, parseBool));

  const set = useCallback(
    (next: boolean) => {
      setOpenState(next);
      writeStorage(key, next ? "1" : "0");
    },
    [key],
  );

  const toggle = useCallback(() => {
    setOpenState((o) => {
      writeStorage(key, o ? "0" : "1");
      return !o;
    });
  }, [key]);

  return [open, toggle, set];
}

function parseBool(raw: string): boolean | undefined {
  if (raw === "1" || raw === "true" || raw === '"true"') return true;
  if (raw === "0" || raw === "false" || raw === '"false"') return false;
  return undefined;
}
