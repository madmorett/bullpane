/**
 * Tiny layered layout for the flow graph. No dagre.
 *
 * - Columns: longest-path depth from any source (edges point from -> to).
 * - Cycles: broken by ignoring back edges found during DFS.
 * - Rows: nodes in a column are ordered by the average row of their predecessors
 *   (barycenter) so edges tend to stay short, then packed top to bottom.
 */
export interface LayoutNode {
  id: string;
}
export interface LayoutEdge {
  from: string;
  to: string;
}
export interface LayoutOptions {
  columnGap?: number;
  rowGap?: number;
  nodeWidth?: number;
  nodeHeight?: number;
}
export interface Positioned {
  id: string;
  x: number;
  y: number;
  depth: number;
  row: number;
}

export function layoutGraph(
  nodes: LayoutNode[],
  edges: LayoutEdge[],
  opts: LayoutOptions = {},
): Map<string, Positioned> {
  const { columnGap = 90, rowGap = 28, nodeWidth = 220, nodeHeight = 84 } = opts;
  const ids = nodes.map((n) => n.id);
  const idSet = new Set(ids);
  const out = new Map<string, string[]>();
  const inn = new Map<string, string[]>();
  ids.forEach((id) => {
    out.set(id, []);
    inn.set(id, []);
  });
  for (const e of edges) {
    if (!idSet.has(e.from) || !idSet.has(e.to) || e.from === e.to) continue;
    out.get(e.from)!.push(e.to);
    inn.get(e.to)!.push(e.from);
  }

  // Break cycles: DFS, drop back edges.
  const color = new Map<string, 0 | 1 | 2>();
  const dagOut = new Map<string, string[]>();
  ids.forEach((id) => {
    color.set(id, 0);
    dagOut.set(id, []);
  });
  const dfs = (u: string) => {
    color.set(u, 1);
    for (const v of out.get(u)!) {
      const c = color.get(v);
      if (c === 1) continue; // back edge -> ignore
      dagOut.get(u)!.push(v);
      if (c === 0) dfs(v);
    }
    color.set(u, 2);
  };
  // start from sources first for nicer results
  const sorted = [...ids].sort((a, b) => inn.get(a)!.length - inn.get(b)!.length);
  for (const id of sorted) if (color.get(id) === 0) dfs(id);

  const dagIn = new Map<string, string[]>();
  ids.forEach((id) => dagIn.set(id, []));
  dagOut.forEach((targets, from) => targets.forEach((to) => dagIn.get(to)!.push(from)));

  // Longest-path depth via topological order (Kahn).
  const indeg = new Map<string, number>();
  ids.forEach((id) => indeg.set(id, dagIn.get(id)!.length));
  const depth = new Map<string, number>();
  const queue = ids.filter((id) => indeg.get(id) === 0);
  queue.forEach((id) => depth.set(id, 0));
  const topo: string[] = [];
  while (queue.length) {
    const u = queue.shift()!;
    topo.push(u);
    for (const v of dagOut.get(u)!) {
      depth.set(v, Math.max(depth.get(v) ?? 0, (depth.get(u) ?? 0) + 1));
      indeg.set(v, indeg.get(v)! - 1);
      if (indeg.get(v) === 0) queue.push(v);
    }
  }
  ids.forEach((id) => {
    if (!depth.has(id)) depth.set(id, 0);
  });

  // Group by column.
  const columns = new Map<number, string[]>();
  ids.forEach((id) => {
    const d = depth.get(id)!;
    if (!columns.has(d)) columns.set(d, []);
    columns.get(d)!.push(id);
  });
  const maxDepth = Math.max(0, ...columns.keys());

  const row = new Map<string, number>();
  for (let d = 0; d <= maxDepth; d++) {
    const col = columns.get(d) ?? [];
    if (d === 0) {
      // sources: stable alphabetical, nodes with more outgoing first
      col.sort((a, b) => dagOut.get(b)!.length - dagOut.get(a)!.length || a.localeCompare(b));
    } else {
      const bary = (id: string) => {
        const preds = dagIn.get(id)!.filter((p) => row.has(p));
        if (preds.length === 0) return Number.POSITIVE_INFINITY;
        return preds.reduce((s, p) => s + row.get(p)!, 0) / preds.length;
      };
      col.sort((a, b) => {
        const ba = bary(a);
        const bb = bary(b);
        if (ba !== bb) return ba - bb;
        return a.localeCompare(b);
      });
    }
    col.forEach((id, i) => row.set(id, i));
  }

  // Centre shorter columns vertically against the tallest.
  const tallest = Math.max(1, ...[...columns.values()].map((c) => c.length));
  const result = new Map<string, Positioned>();
  columns.forEach((col, d) => {
    const offset = ((tallest - col.length) * (nodeHeight + rowGap)) / 2;
    col.forEach((id) => {
      const r = row.get(id)!;
      result.set(id, {
        id,
        depth: d,
        row: r,
        x: d * (nodeWidth + columnGap),
        y: offset + r * (nodeHeight + rowGap),
      });
    });
  });
  return result;
}
