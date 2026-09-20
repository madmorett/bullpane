/**
 * The parent/child tree of ONE flow instance.
 *
 * This is the job-level companion to /flows: that page draws queues and how they
 * feed each other, this one draws the actual jobs of a single flow. It exists to
 * answer the question a queue graph cannot — "my parent is stuck in
 * waiting-children; WHICH child is it waiting on".
 *
 * Free edition on purpose: this is the drill-down bull-board offers, and the free
 * tier's promise is that it does everything bull-board does.
 */
import { memo, useCallback, useEffect, useMemo } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import {
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  MarkerType,
  MiniMap,
  Position,
  ReactFlow,
  useEdgesState,
  useNodesState,
  type Edge,
  type Node,
  type NodeProps,
  type NodeTypes,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { AlertTriangle, ArrowLeft, GitBranch, Loader2 } from "lucide-react";
import type { JobTreeNode } from "@bullpane/shared";
import { cn } from "@/lib/cn";
import { routes } from "@/lib/routes";
import { formatNumber, formatRelative } from "@/lib/format";
import { chipStyle, stateColor } from "@/lib/stateColors";
import { layoutGraph } from "@/lib/flowLayout";
import { useJobTree } from "@/api/hooks";
import { errorMessage } from "@/api/client";
import { Badge } from "@/components/ui/Badge";
import { Spinner } from "@/components/ui/Spinner";
import { EmptyState } from "@/components/ui/EmptyState";
import { Page, PageHeader } from "@/components/layout/AppShell";

const NODE_W = 230;
const NODE_H = 92;

type JobNodeData = {
  node: JobTreeNode;
  connectionId: string;
  isFocus: boolean;
  /** this node is why its parent is stuck: unfinished child of a waiting parent */
  isBlocker: boolean;
};
type JobFlowNode = Node<JobNodeData, "job">;

export function JobTreePage() {
  const { connectionId, queue, jobId } = useParams<{ connectionId: string; queue: string; jobId: string }>();
  const [params] = useSearchParams();
  const maxNodes = Number(params.get("maxNodes")) || 200;

  const tree = useJobTree(connectionId, queue, jobId, maxNodes);

  if (tree.isLoading) {
    return (
      <Page>
        <PageHeader title="Flow tree" />
        <Spinner label="Walking the flow…" />
      </Page>
    );
  }

  if (tree.isError || !tree.data) {
    return (
      <Page>
        <PageHeader title="Flow tree" />
        <EmptyState
          icon={<GitBranch />}
          title="Could not load the flow"
          description={tree.isError ? errorMessage(tree.error) : "This job no longer exists."}
          action={
            <Link to={routes.queue(connectionId!, queue!)} className="text-accent hover:underline">
              Back to {queue}
            </Link>
          }
        />
      </Page>
    );
  }

  const data = tree.data;
  const isSingle = data.nodes.length <= 1;

  return (
    <Page>
      <PageHeader
        title="Flow tree"
        description={`${formatNumber(data.nodes.length)} job${data.nodes.length === 1 ? "" : "s"}${data.climbedLevels > 0 ? ` · root is ${data.climbedLevels} level${data.climbedLevels === 1 ? "" : "s"} up` : ""}`}
        actions={
          <Link to={routes.job(connectionId!, queue!, jobId!)} className="inline-flex items-center gap-1.5 text-[13px] text-accent hover:underline">
            <ArrowLeft className="size-3.5" aria-hidden />
            Back to job
          </Link>
        }
      />
      {data.truncated && (
        <div className="mb-3 flex items-start gap-2 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-fg-muted">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-warning" aria-hidden />
          <span>
            This flow is larger than {formatNumber(maxNodes)} jobs, so only part of it is drawn. Child counts on each card come straight from Redis and are exact even
            where the tree is cut.
          </span>
        </div>
      )}

      {isSingle ? (
        <EmptyState
          icon={<GitBranch />}
          title="This job is not part of a flow"
          description="It has no parent and no children. Flows are created with FlowProducer, which links a parent job to the children it waits on."
          action={
            <Link to={routes.job(connectionId!, queue!, jobId!)} className="text-accent hover:underline">
              Back to job
            </Link>
          }
        />
      ) : (
        <TreeCanvas data={data} connectionId={connectionId!} />
      )}
    </Page>
  );
}

function TreeCanvas({ data, connectionId }: { data: NonNullable<ReturnType<typeof useJobTree>["data"]>; connectionId: string }) {
  const { nodes: initialNodes, edges: initialEdges } = useMemo(() => build(data, connectionId), [data, connectionId]);
  const [nodes, setNodes, onNodesChange] = useNodesState<JobFlowNode>(initialNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>(initialEdges);

  // The tree polls while jobs are still running; refresh the canvas in place
  // rather than remounting it, so pan/zoom survives a state change.
  useEffect(() => {
    setNodes(initialNodes);
    setEdges(initialEdges);
  }, [initialNodes, initialEdges, setNodes, setEdges]);

  const nodeTypes = useMemo<NodeTypes>(() => ({ job: JobNodeView }), []);
  const miniMapColor = useCallback((n: Node) => stateColor((n.data as JobNodeData).node.state).fg, []);

  return (
    <div className="card h-[calc(100vh-220px)] min-h-[420px] overflow-hidden">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        nodeTypes={nodeTypes}
        fitView
        minZoom={0.1}
        proOptions={{ hideAttribution: true }}
        nodesConnectable={false}
        edgesFocusable={false}
      >
        <Background variant={BackgroundVariant.Dots} gap={16} size={1} />
        <Controls showInteractive={false} />
        {/* Same treatment as the queue graph's minimap: React Flow paints its own
            SVG, so the mask and size go through its props, not a Tailwind class. */}
        <MiniMap
          pannable
          zoomable
          position="bottom-right"
          nodeColor={miniMapColor}
          maskColor="color-mix(in srgb, var(--bg) 70%, transparent)"
          style={{ width: 160, height: 100, background: "var(--surface)" }}
        />
      </ReactFlow>
    </div>
  );
}

/** JobTree -> positioned React Flow nodes and edges. */
function build(
  data: { nodes: JobTreeNode[]; focusKey: string },
  connectionId: string,
): { nodes: JobFlowNode[]; edges: Edge[] } {
  const byKey = new Map(data.nodes.map((n) => [n.key, n]));

  const layoutEdges = data.nodes
    .filter((n) => n.parentKey && byKey.has(n.parentKey))
    // Parent on the left, children to its right: a flow reads as "this waits on those".
    .map((n) => ({ from: n.parentKey!, to: n.key }));

  const positions = layoutGraph(
    data.nodes.map((n) => ({ id: n.key })),
    layoutEdges,
    { nodeWidth: NODE_W, nodeHeight: NODE_H, columnGap: 100, rowGap: 24 },
  );

  const nodes: JobFlowNode[] = data.nodes.map((n) => {
    const parent = n.parentKey ? byKey.get(n.parentKey) : undefined;
    // A blocker is an unfinished child of a parent that is actually waiting on it.
    const isBlocker = !!parent && parent.state === "waiting-children" && n.finishedOn === null && !n.missing;
    const p = positions.get(n.key);
    return {
      id: n.key,
      type: "job",
      position: { x: p?.x ?? 0, y: p?.y ?? 0 },
      data: { node: n, connectionId, isFocus: n.key === data.focusKey, isBlocker },
    };
  });

  const edges: Edge[] = layoutEdges.map((e) => {
    const child = byKey.get(e.to);
    const parent = byKey.get(e.from);
    const pending = !!child && child.finishedOn === null && parent?.state === "waiting-children";
    return {
      id: `${e.from}->${e.to}`,
      source: e.from,
      target: e.to,
      animated: pending,
      style: pending ? { stroke: stateColor("waiting-children").fg } : undefined,
      markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14 },
    };
  });

  return { nodes, edges };
}

const JobNodeView = memo(function JobNodeView({ data }: NodeProps<JobFlowNode>) {
  const { node, connectionId, isFocus, isBlocker } = data;
  const color = stateColor(node.state);
  const deps = node.dependencies;

  return (
    <div
      className={cn(
        "rounded-lg border bg-surface px-3 py-2 text-fg shadow-sm",
        isFocus ? "border-accent ring-2 ring-accent/30" : "border-border-strong",
        isBlocker && !isFocus && "border-warning",
        node.missing && "border-dashed opacity-70",
      )}
      style={{ width: NODE_W }}
    >
      <Handle type="target" position={Position.Left} className="!bg-border-strong" />
      <Handle type="source" position={Position.Right} className="!bg-border-strong" />

      <div className="flex items-center gap-1.5">
        <span className={cn("size-2 shrink-0 rounded-full", color.dotClass)} aria-hidden />
        <span className="truncate text-[11px] text-fg-subtle" title={node.queueName}>
          {node.queueName}
        </span>
        {isBlocker && (
          <Badge variant="outline" size="xs" className="ml-auto border-warning/50 text-warning">
            blocking
          </Badge>
        )}
      </div>

      {node.missing ? (
        <p className="mt-1 truncate font-mono text-[13px] text-fg-subtle" title="This child was removed or cleaned">
          {node.id} · gone
        </p>
      ) : (
        <Link
          to={routes.job(connectionId, node.queueName, node.id)}
          className="mt-1 block truncate font-mono text-[13px] text-accent hover:underline"
          title={`${node.name || "job"} #${node.id}`}
        >
          {node.name || "job"} #{node.id}
        </Link>
      )}

      <div className="mt-1 flex items-center gap-1.5">
        <span className="state-chip" style={chipStyle(node.state)}>
          {node.state === "active" && <Loader2 className="size-2.5 animate-spin" aria-hidden />}
          {color.label}
        </span>
        {deps && (
          <span className="text-[11px] text-fg-subtle" title="Children of this job">
            <span className="text-success">{formatNumber(deps.processed)}</span>/
            {formatNumber(deps.processed + deps.unprocessed)}
          </span>
        )}
        {node.attemptsMade > 1 && (
          <span className="text-[11px] text-fg-subtle" title="Attempts made">
            ×{node.attemptsMade}
          </span>
        )}
        <span className="ml-auto shrink-0 text-[11px] text-fg-subtle">
          {node.finishedOn ? formatRelative(node.finishedOn) : node.timestamp ? formatRelative(node.timestamp) : ""}
        </span>
      </div>

      {node.childrenTruncated && <p className="mt-1 text-[10px] text-warning">more children not shown</p>}
    </div>
  );
});
