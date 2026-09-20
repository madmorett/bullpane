/**
 * Per-queue counters for the compact status line printed every 10 s.
 */
export interface QueueCounters {
  added: number;
  completed: number;
  failed: number;
}

export class Stats {
  private readonly counters = new Map<string, QueueCounters>();
  private readonly notes: string[] = [];

  private get(queue: string): QueueCounters {
    let c = this.counters.get(queue);
    if (!c) {
      c = { added: 0, completed: 0, failed: 0 };
      this.counters.set(queue, c);
    }
    return c;
  }

  added(queue: string, n = 1): void {
    this.get(queue).added += n;
  }
  completed(queue: string, n = 1): void {
    this.get(queue).completed += n;
  }
  failed(queue: string, n = 1): void {
    this.get(queue).failed += n;
  }
  /** One-off event worth surfacing in the next status line (e.g. "outage started"). */
  note(text: string): void {
    this.notes.push(text);
  }

  /** Renders the window and resets the counters. */
  flush(): string {
    const parts: string[] = [];
    for (const [queue, c] of [...this.counters.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      if (c.added === 0 && c.completed === 0 && c.failed === 0) continue;
      parts.push(`${queue} +${c.added}/ok ${c.completed}/x ${c.failed}`);
      c.added = 0;
      c.completed = 0;
      c.failed = 0;
    }
    const notes = this.notes.length ? `  | ${this.notes.join("; ")}` : "";
    this.notes.length = 0;
    return parts.length ? parts.join("  ") + notes : "(idle)" + notes;
  }
}
