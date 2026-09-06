/**
 * Flow graph: one node per discovered queue (counts from a single getQueueStats
 * call), detected edges from sampleFlowEdges (concurrency 5, cached 30 s per
 * connection) + manual edges from the flow_edges table.
 */
import { EMPTY_COUNTS, type FlowEdge, type FlowGraph, type FlowNode } from "@bullmq-visualizer/shared";
import type { Inspector } from "@bullmq-visualizer/redis-inspector";
import { and, eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import type { Db } from "../db";
import { type ConnectionRow, type FlowEdgeRow, flowEdges } from "../db/schema";
import { conflict, notFound } from "../plugins/errors";
import type { ConnectionsService } from "./connections";
import { withRedis } from "./inspector-errors";

export const FLOW_CACHE_TTL_MS = 30_000;
export const FLOW_CONCURRENCY = 5;

interface DetectedGraph {
  nodes: FlowNode[];
  edges: FlowEdge[];
  sampledJobs: number;
}

interface CacheEntry {
  at: number;
  sample: number;
  value: Promise<DetectedGraph>;
}

export function detectedEdgeId(from: string, to: string): string {
  return `d:${from}->${to}`;
}

export function toFlowEdgeDto(row: FlowEdgeRow): FlowEdge {
  return { id: row.id, from: row.fromQueue, to: row.toQueue, source: "manual", evidence: 0, label: row.label ?? null };
}

/** Run `fn` over `items` with at most `limit` in flight. Order of results preserved. */
export async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index] as T);
    }
  });
  await Promise.all(workers);
  return results;
}

export class FlowsService {
  private readonly cache = new Map<string, CacheEntry>();

  constructor(
    private readonly db: Db,
    private readonly connections: ConnectionsService,
  ) {}

  async getGraph(connectionId: string, sample: number): Promise<FlowGraph> {
    const row = await this.connections.getRow(connectionId);
    const [detected, manual] = await Promise.all([this.detected(row, sample), this.manualEdges(connectionId)]);

    // Manual edges may reference queues that are not discovered (yet); still draw them.
    const nodeIds = new Set(detected.nodes.map((n) => n.id));
    const nodes = [...detected.nodes];
    for (const edge of manual) {
      for (const name of [edge.from, edge.to]) {
        if (!nodeIds.has(name)) {
          nodeIds.add(name);
          nodes.push({ id: name, queueName: name, counts: { ...EMPTY_COUNTS }, isPaused: false });
        }
      }
    }

    return {
      connectionId,
      nodes,
      edges: [...detected.edges, ...manual],
      sampledJobs: detected.sampledJobs,
    };
  }

  invalidate(connectionId: string): void {
    this.cache.delete(connectionId);
  }

  private detected(row: ConnectionRow, sample: number): Promise<DetectedGraph> {
    const cached = this.cache.get(row.id);
    const now = Date.now();
    if (cached && cached.sample === sample && now - cached.at < FLOW_CACHE_TTL_MS) return cached.value;

    const value = withRedis(() => this.computeDetected(this.connections.inspectorFor(row), sample));
    this.cache.set(row.id, { at: now, sample, value });
    value.catch(() => this.cache.delete(row.id));
    return value;
  }

  private async computeDetected(inspector: Inspector, sample: number): Promise<DetectedGraph> {
    const names = await inspector.discoverQueues();
    if (names.length === 0) return { nodes: [], edges: [], sampledJobs: 0 };
    const stats = await inspector.getQueueStats(names);

    const nodes: FlowNode[] = names.map((name) => ({
      id: name,
      queueName: name,
      counts: stats[name]?.counts ?? { ...EMPTY_COUNTS },
      isPaused: stats[name]?.isPaused ?? false,
    }));

    const samples = await mapWithConcurrency(names, FLOW_CONCURRENCY, (name) =>
      inspector.sampleFlowEdges(name, { sample }),
    );

    const edgeMap = new Map<string, FlowEdge>();
    let sampledJobs = 0;
    for (const result of samples) {
      sampledJobs += result.sampled;
      for (const e of result.edges) {
        const id = detectedEdgeId(e.childQueue, e.parentQueue);
        const existing = edgeMap.get(id);
        if (existing) {
          existing.evidence += e.count;
        } else {
          edgeMap.set(id, {
            id,
            from: e.childQueue,
            to: e.parentQueue,
            source: "detected",
            evidence: e.count,
            label: null,
          });
        }
      }
    }
    return { nodes, edges: [...edgeMap.values()], sampledJobs };
  }

  private async manualEdges(connectionId: string): Promise<FlowEdge[]> {
    const rows = await this.db.select().from(flowEdges).where(eq(flowEdges.connectionId, connectionId));
    return rows.map(toFlowEdgeDto);
  }

  async createManualEdge(input: { connectionId: string; from: string; to: string; label?: string | null }): Promise<FlowEdge> {
    await this.connections.getRow(input.connectionId);
    if (input.from === input.to) throw conflict("A queue cannot flow into itself");
    const existing = await this.db
      .select({ id: flowEdges.id })
      .from(flowEdges)
      .where(
        and(
          eq(flowEdges.connectionId, input.connectionId),
          eq(flowEdges.fromQueue, input.from),
          eq(flowEdges.toQueue, input.to),
        ),
      )
      .limit(1);
    if (existing[0]) throw conflict("This edge already exists");
    const id = nanoid();
    await this.db.insert(flowEdges).values({
      id,
      connectionId: input.connectionId,
      fromQueue: input.from,
      toQueue: input.to,
      label: input.label ?? null,
      createdAt: new Date(),
    });
    const rows = await this.db.select().from(flowEdges).where(eq(flowEdges.id, id)).limit(1);
    const row = rows[0];
    if (!row) throw notFound("Flow edge");
    return toFlowEdgeDto(row);
  }

  async deleteManualEdge(id: string): Promise<void> {
    const rows = await this.db.select({ id: flowEdges.id }).from(flowEdges).where(eq(flowEdges.id, id)).limit(1);
    if (!rows[0]) throw notFound("Flow edge");
    await this.db.delete(flowEdges).where(eq(flowEdges.id, id));
  }
}
