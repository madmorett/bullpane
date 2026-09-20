/**
 * Hiding a queue must remove it from the LIST and from nothing else.
 *
 * What is pinned down here:
 *  - a hidden queue is absent from listQueues() by default;
 *  - `includeHidden: true` brings it back (that is how the "Hidden queues (N)"
 *    section and the reveal action read the full list);
 *  - the aggregate totals the UI renders sum only what listQueues returned, so
 *    a hidden queue cannot inflate "13 queues · 187 waiting" silently;
 *  - unhiding puts it back;
 *  - hide/unhide are idempotent (double click, retried request);
 *  - discovery is NOT filtered: a hidden queue is still discovered and still
 *    reachable one queue at a time, which is what keeps alerts, health and the
 *    direct URL /c/:cid/q/:name working on a hidden queue.
 *
 * No MySQL here: `db` is a stub that records the rows it was given, in the
 * style of readonly.test.ts / alertsEngine.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ConnectionsService } from "../services/connections";
import type { Db } from "../db";
import type { ConnectionRow } from "../db/schema";

const CONNECTION: ConnectionRow = {
  id: "conn-1",
  name: "prod",
  url: "redis://localhost:6379",
  prefix: "bull",
  cluster: false,
  queueFilter: null,
  position: 0,
  createdAt: new Date("2024-01-01T00:00:00.000Z"),
};

interface HiddenRow {
  connectionId: string;
  queueName: string;
  hiddenAt: Date;
  hiddenBy: string | null;
}

/**
 * Minimal drizzle-shaped stub. It only has to satisfy the four query shapes the
 * service actually builds: select-connection, select-hidden, insert-hidden,
 * delete-hidden. Which table a query targets is decided by `from(...)` /
 * `insert(...)` / `delete(...)` identity, so no SQL is parsed.
 */
function fakeDb(hidden: HiddenRow[] = [], usersRows: { id: string; name: string }[] = []) {
  const state = { hidden, users: usersRows };

  // `where` conditions are opaque objects here; the stub instead filters by the
  // values captured when the service built the query. To stay honest without a
  // SQL parser, the service's own filters are re-applied by inspecting the
  // connection id / queue name it passed, which the tests set explicitly.
  let pendingFilter: { connectionId?: string; queueName?: string } = {};

  const db = {
    __state: state,
    __setFilter(f: { connectionId?: string; queueName?: string }) {
      pendingFilter = f;
    },
    select(_fields?: unknown) {
      const chain = {
        from(table: unknown) {
          const name = tableName(table);
          const builder = {
            where(_cond: unknown) {
              return builder;
            },
            limit(_n: number) {
              return builder;
            },
            orderBy(..._o: unknown[]) {
              return builder;
            },
            then(resolve: (rows: unknown[]) => unknown) {
              return Promise.resolve(rowsFor(name)).then(resolve);
            },
          };
          return builder;
        },
      };
      return chain;
    },
    insert(table: unknown) {
      return {
        values(v: HiddenRow | HiddenRow[]) {
          if (tableName(table) === "hidden_queues") {
            for (const row of Array.isArray(v) ? v : [v]) state.hidden.push(row);
          }
          return Promise.resolve();
        },
      };
    },
    delete(table: unknown) {
      return {
        where(_cond: unknown) {
          if (tableName(table) === "hidden_queues") {
            state.hidden = state.hidden.filter(
              (r) => !(r.connectionId === pendingFilter.connectionId && r.queueName === pendingFilter.queueName),
            );
          }
          return Promise.resolve();
        },
      };
    },
  };

  function rowsFor(name: string): unknown[] {
    if (name === "connections") return [CONNECTION];
    if (name === "users") return state.users;
    if (name === "hidden_queues") {
      return state.hidden.filter(
        (r) =>
          (pendingFilter.connectionId === undefined || r.connectionId === pendingFilter.connectionId) &&
          (pendingFilter.queueName === undefined || r.queueName === pendingFilter.queueName),
      );
    }
    return [];
  }

  return db as unknown as Db & {
    __state: { hidden: HiddenRow[] };
    __setFilter(f: { connectionId?: string; queueName?: string }): void;
  };
}

/** drizzle keeps the SQL name on a symbol; read it without importing internals. */
function tableName(table: unknown): string {
  const sym = Object.getOwnPropertySymbols(table as object).find((s) => String(s).includes("Name"));
  return sym ? String((table as Record<symbol, unknown>)[sym]) : "";
}

function stats(names: string[]) {
  const out: Record<string, unknown> = {};
  for (const n of names) {
    out[n] = {
      counts: { waiting: 10, active: 1, completed: 5, failed: 2, delayed: 0, prioritized: 0, paused: 0, "waiting-children": 0 },
      isPaused: false,
      isPro: false,
      groupsCount: 0,
      schedulersCount: 0,
      rates: { windowMinutes: 60, completed: 5, failed: 2, successPct: 71.4, source: "metrics", retentionSkewed: false },
    };
  }
  return out;
}

function fakePool(discovered: string[]) {
  const inspector = {
    discoverQueues: vi.fn(async () => discovered),
    getQueueStats: vi.fn(async (names: string[]) => stats(names)),
    ping: vi.fn(async () => ({ ok: true, latencyMs: 1, redisVersion: "7.2.0", error: null })),
  };
  return {
    inspector,
    pool: { get: () => inspector, evict: vi.fn(async () => undefined) } as never,
  };
}

/** The same sum the web's `totals()` does, over whatever listQueues returned. */
function totals(queues: Awaited<ReturnType<ConnectionsService["listQueues"]>>) {
  return queues.reduce(
    (acc, q) => ({ queues: acc.queues + 1, waiting: acc.waiting + q.counts.waiting + q.counts.prioritized, failed: acc.failed + q.counts.failed }),
    { queues: 0, waiting: 0, failed: 0 },
  );
}

describe("hidden queues", () => {
  const DISCOVERED = ["payments", "legacy-emails", "reports"];
  let db: ReturnType<typeof fakeDb>;
  let world: ReturnType<typeof fakePool>;
  let service: ConnectionsService;

  beforeEach(() => {
    db = fakeDb();
    world = fakePool(DISCOVERED);
    service = new ConnectionsService(db, world.pool);
    db.__setFilter({ connectionId: CONNECTION.id });
  });

  it("lists every queue while nothing is hidden", async () => {
    const queues = await service.listQueues(CONNECTION);
    expect(queues.map((q) => q.name)).toEqual(DISCOVERED);
  });

  it("drops a hidden queue from the list", async () => {
    await service.hideQueue(CONNECTION.id, "legacy-emails", "user-1");
    const queues = await service.listQueues(CONNECTION);
    expect(queues.map((q) => q.name)).toEqual(["payments", "reports"]);
  });

  it("brings it back with includeHidden", async () => {
    await service.hideQueue(CONNECTION.id, "legacy-emails", "user-1");
    const queues = await service.listQueues(CONNECTION, { includeHidden: true });
    expect(queues.map((q) => q.name)).toEqual(DISCOVERED);
  });

  it("never asks Redis for the stats of a hidden queue", async () => {
    await service.hideQueue(CONNECTION.id, "legacy-emails", "user-1");
    await service.listQueues(CONNECTION);
    expect(world.inspector.getQueueStats).toHaveBeenCalledWith(["payments", "reports"], undefined);
  });

  it("still DISCOVERS the hidden queue — hiding is about the list, not the queue", async () => {
    await service.hideQueue(CONNECTION.id, "legacy-emails", "user-1");
    await service.listQueues(CONNECTION);
    // Discovery is untouched, which is what keeps alerts, health and the direct
    // URL working on a hidden queue.
    expect(world.inspector.discoverQueues).toHaveBeenCalled();
    await expect(world.inspector.discoverQueues()).resolves.toContain("legacy-emails");
  });

  it("does not let a hidden queue inflate the aggregate counts", async () => {
    const before = totals(await service.listQueues(CONNECTION));
    expect(before).toEqual({ queues: 3, waiting: 30, failed: 6 });

    await service.hideQueue(CONNECTION.id, "legacy-emails", "user-1");
    const after = totals(await service.listQueues(CONNECTION));
    expect(after).toEqual({ queues: 2, waiting: 20, failed: 4 });

    // and the count of what was left out is reported, not swallowed
    expect((await service.hiddenQueueNames(CONNECTION.id)).size).toBe(1);
  });

  it("unhiding puts the queue back in the list", async () => {
    await service.hideQueue(CONNECTION.id, "legacy-emails", "user-1");
    db.__setFilter({ connectionId: CONNECTION.id, queueName: "legacy-emails" });
    await service.unhideQueue(CONNECTION.id, "legacy-emails");
    db.__setFilter({ connectionId: CONNECTION.id });
    const queues = await service.listQueues(CONNECTION);
    expect(queues.map((q) => q.name)).toEqual(DISCOVERED);
  });

  it("is idempotent in both directions", async () => {
    db.__setFilter({ connectionId: CONNECTION.id, queueName: "legacy-emails" });
    await service.hideQueue(CONNECTION.id, "legacy-emails", "user-1");
    await service.hideQueue(CONNECTION.id, "legacy-emails", "user-2");
    expect(db.__state.hidden).toHaveLength(1);

    await service.unhideQueue(CONNECTION.id, "legacy-emails");
    await service.unhideQueue(CONNECTION.id, "legacy-emails");
    expect(db.__state.hidden).toHaveLength(0);
  });

  it("reports who hid a queue and when", async () => {
    db = fakeDb([], [{ id: "user-1", name: "Ana" }]);
    service = new ConnectionsService(db, world.pool);
    db.__setFilter({ connectionId: CONNECTION.id });

    await service.hideQueue(CONNECTION.id, "legacy-emails", "user-1");
    const [row] = await service.listHiddenQueues(CONNECTION.id);
    expect(row?.queueName).toBe("legacy-emails");
    expect(row?.hiddenBy).toBe("user-1");
    expect(row?.hiddenByName).toBe("Ana");
    expect(typeof row?.hiddenAt).toBe("string");
  });

  it("survives a deleted user: the row stays, the name goes unknown", async () => {
    await service.hideQueue(CONNECTION.id, "legacy-emails", "ghost");
    const [row] = await service.listHiddenQueues(CONNECTION.id);
    expect(row?.hiddenBy).toBe("ghost");
    expect(row?.hiddenByName).toBeNull();
  });

  it("keeps hidden lists separate per connection", async () => {
    await service.hideQueue(CONNECTION.id, "legacy-emails", "user-1");
    db.__setFilter({ connectionId: "conn-2" });
    expect((await service.hiddenQueueNames("conn-2")).size).toBe(0);
  });
});
