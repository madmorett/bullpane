import { useEffect, useState } from "react";

/**
 * Shared ticker so hundreds of RelativeTime cells do not each own an interval.
 * The timer runs at the smallest interval any subscriber asked for.
 */
const listeners = new Map<() => void, number>();
let timer: ReturnType<typeof setInterval> | null = null;
let currentInterval = Number.POSITIVE_INFINITY;
let now = Date.now();

function tick() {
  if (document.hidden) return;
  now = Date.now();
  listeners.forEach((_, l) => l());
}

function syncTimer() {
  const wanted = listeners.size ? Math.min(...listeners.values()) : Number.POSITIVE_INFINITY;
  if (wanted === currentInterval) return;
  if (timer) clearInterval(timer);
  timer = null;
  currentInterval = wanted;
  if (Number.isFinite(wanted)) timer = setInterval(tick, wanted);
}

export function useNow(intervalMs = 15_000): number {
  const [, force] = useState(0);
  useEffect(() => {
    const l = () => force((n) => n + 1);
    listeners.set(l, intervalMs);
    syncTimer();
    return () => {
      listeners.delete(l);
      syncTimer();
    };
  }, [intervalMs]);
  return now;
}
