import { useSyncExternalStore } from "react";
import type { ProFeature } from "@bullpane/shared";

/**
 * Module-level store so the API client (not a React component) can open the
 * upsell dialog when the server answers 402.
 */
interface UpsellState {
  open: boolean;
  feature: ProFeature;
}

let state: UpsellState = { open: false, feature: "alerts" };
const listeners = new Set<() => void>();

function set(next: UpsellState) {
  state = next;
  listeners.forEach((l) => l());
}

export function openUpsell(feature: ProFeature | undefined) {
  set({ open: true, feature: feature ?? state.feature });
}

export function closeUpsell() {
  if (state.open) set({ ...state, open: false });
}

export function useUpsellState(): UpsellState {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => state,
    () => state,
  );
}
