import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, Navigate, useNavigate, useParams } from "react-router-dom";
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
import { ExternalLink, Info, Link2, Plus, RefreshCw, Trash2, Workflow } from "lucide-react";
import type { FlowEdge, FlowGraph, FlowNode } from "@bullpane/shared";
import { cn } from "@/lib/cn";
import { routes } from "@/lib/routes";
import { formatCompact, formatNumber } from "@/lib/format";
import { STATE_COLORS } from "@/lib/stateColors";
import { layoutGraph } from "@/lib/flowLayout";
import { useConnections, useCreateFlowEdge, useDeleteFlowEdge, useFlows } from "@/api/hooks";
import { errorMessage } from "@/api/client";
import { useAuth } from "@/auth/AuthProvider";
import { useEdition } from "@/edition/useEdition";
import { LockedFeature } from "@/edition/LockedFeature";
import { toast } from "@/components/Toast";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { Dialog } from "@/components/ui/Dialog";
import { Input, Select } from "@/components/ui/Input";
import { EmptyState } from "@/components/ui/EmptyState";
import { Spinner } from "@/components/ui/Spinner";
import { Page } from "@/components/layout/AppShell";

const NODE_W = 220;
const NODE_H = 84;

type QueueNodeData = { node: FlowNode; connectionId: string };
type QueueNode = Node<QueueNodeData, "queue">;
type EdgeData = { edge: FlowEdge };
type FlowEdgeT = Edge<EdgeData>;

/** /flows → first connection */
export function FlowsIndexPage() {
  const { has } = useEdition();
  const connections = useConnections();
  if (!has("flows")) return <LockedFeature feature="flows" />;
  if (connections.isLoading) return <Page>{<Spinner label="Loading…" />}</Page>;
  const first = connections.data?.[0];
  if (!first) {
    return (
      <Page>
        <EmptyState icon={<Workflow />} title="No connections" description="Add a Redis connection first; flows are detected per connection." />
      </Page>
    );
  }
  return <Navigate to={routes.flows(first.id)} replace />;
}

export function FlowsPage() {
  const { has } = useEdition();
  if (!has("flows")) return <LockedFeature feature="flows" />;
  return <FlowsCanvas />;
}

const QueueNodeView = memo(function QueueNodeView({ data, selected }: NodeProps<QueueNode>) {
  const { node, connectionId } = data;
  const c = node.counts;
  return (
    <div
      className={cn(
        "rounded-lg border bg-surface px-3 py-2 text-fg shadow-sm transition-colors",
        selected ? "border-accent ring-2 ring-accent/30" : "border-border-strong",
        node.isPaused && "border-dashed",
      )}
      style={{ width: NODE_W, height: NODE_H }}
    >
      <Handle type="target" position={Position.Left} className="!size-2 !border-0 !bg-fg-subtle" />
      <div className="flex items-center gap-2">
        <span className="truncate text-[13px] font-semibold" title={node.queueName}>
          {node.queueName}
        </span>
        {node.isPaused && (
          <Badge variant="warning" size="xs" className="ml-auto">
            paused
          </Badge>
        )}
      </div>
      <div className="mt-1.5 grid grid-cols-3 gap-1 text-[11px]">
        <Count label="waiting" value={c.waiting + c.prioritized} tone={STATE_COLORS.waiting.textClass} />
        <Count label="active" value={c.active} tone={STATE_COLORS.active.textClass} />
        <Count label="failed" value={c.failed} tone={c.failed > 0 ? STATE_COLORS.failed.textClass : "text-fg-subtle"} />
      </div>
      <Link to={routes.queue(connectionId, node.queueName)} className="absolute top-1.5 right-1.5 rounded p-0.5 text-fg-subtle hover:text-fg" title="Open queue" aria-label="Open queue">
        <ExternalLink className="size-3" />
      </Link>
      <Handle type="source" position={Position.Right} className="!size-2 !border-0 !bg-fg-subtle" />
    </div>
  );
});

function Count({ label, value, tone }: { label: string; value: number; tone: string }) {
  return (
    <span className="flex flex-col leading-tight">
      <span className={cn("num font-semibold", tone)}>{formatCompact(value)}</span>
      <span className="text-[10px] text-fg-subtle">{label}</span>
    </span>
  );
}

const nodeTypes: NodeTypes = { queue: QueueNodeView };

function buildEdge(e: FlowEdge): FlowEdgeT {
  const manual = e.source === "manual";
  return {
    id: e.id,
    source: e.from,
    target: e.to,
    type: "smoothstep",
    data: { edge: e },
    label: manual ? e.label ?? undefined : `×${formatNumber(e.evidence)}${e.label ? ` · ${e.label}` : ""}`,
    labelStyle: { fontSize: 10, fill: "var(--fg-muted)" },
    labelBgStyle: { fill: "var(--surface)", fillOpacity: 0.9 },
    labelBgPadding: [4, 2],
    labelBgBorderRadius: 3,
    style: manual ? { stroke: "var(--accent)", strokeDasharray: "6 4", strokeWidth: 1.5 } : { stroke: "var(--fg-subtle)", strokeWidth: Math.min(4, 1 + Math.log10(Math.max(1, e.evidence))) },
    markerEnd: { type: MarkerType.ArrowClosed, color: manual ? "var(--accent)" : "var(--fg-subtle)", width: 16, height: 16 },
    animated: false,
  };
}

function FlowsCanvas() {
  const { connectionId = "" } = useParams();
  const navigate = useNavigate();
  const { isOperator } = useAuth();
  const connections = useConnections();
  const [sample, setSample] = useState(200);
  const flows = useFlows(connectionId, sample);
  const createEdge = useCreateFlowEdge();
  const deleteEdge = useDeleteFlowEdge();

  const [nodes, setNodes, onNodesChange] = useNodesState<QueueNode>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<FlowEdgeT>([]);
  const moved = useRef(new Map<string, { x: number; y: number }>());
  const [selectedEdge, setSelectedEdge] = useState<FlowEdge | null>(null);
  const [selectedNode, setSelectedNode] = useState<FlowNode | null>(null);
  const [adding, setAdding] = useState(false);

  // Rebuild nodes/edges when the graph changes; keep positions the user dragged.
  useEffect(() => {
    const g: FlowGraph | undefined = flows.data;
    if (!g) return;
    const pos = layoutGraph(g.nodes.map((n) => ({ id: n.id })), g.edges.map((e) => ({ from: e.from, to: e.to })), { nodeWidth: NODE_W, nodeHeight: NODE_H });
    setNodes(
      g.nodes.map((n) => {
        const p = moved.current.get(n.id) ?? pos.get(n.id) ?? { x: 0, y: 0 };
        return { id: n.id, type: "queue", position: { x: p.x, y: p.y }, data: { node: n, connectionId }, draggable: true };
      }),
    );
    setEdges(g.edges.map(buildEdge));
    setSelectedEdge((cur) => (cur ? g.edges.find((e) => e.id === cur.id) ?? null : null));
    setSelectedNode((cur) => (cur ? g.nodes.find((n) => n.id === cur.id) ?? null : null));
  }, [flows.data, connectionId, setNodes, setEdges]);

  useEffect(() => {
    moved.current.clear();
  }, [connectionId]);

  const resetLayout = useCallback(() => {
    moved.current.clear();
    const g = flows.data;
    if (!g) return;
    const pos = layoutGraph(g.nodes.map((n) => ({ id: n.id })), g.edges.map((e) => ({ from: e.from, to: e.to })), { nodeWidth: NODE_W, nodeHeight: NODE_H });
    setNodes((ns) => ns.map((n) => ({ ...n, position: pos.get(n.id) ?? n.position })));
  }, [flows.data, setNodes]);

  const detected = flows.data?.edges.filter((e) => e.source === "detected").length ?? 0;
  const manual = flows.data?.edges.filter((e) => e.source === "manual").length ?? 0;

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-border bg-surface px-4 py-2">
        <Workflow className="size-4 text-pro" aria-hidden />
        <h1 className="text-sm font-semibold">Flows</h1>
        <Select aria-label="Connection" className="!h-7 !w-auto text-xs" value={connectionId} onChange={(e) => navigate(routes.flows(e.target.value))} options={(connections.data ?? []).map((c) => ({ value: c.id, label: c.name }))} />
        <Select aria-label="Sample size" className="!h-7 !w-auto text-xs" value={String(sample)} onChange={(e) => setSample(Number(e.target.value))} options={[50, 200, 500, 1000].map((n) => ({ value: String(n), label: `sample ${n} jobs/queue` }))} />
        <span className="text-xs text-fg-muted">
          {flows.data ? (
            <>
              {formatNumber(flows.data.nodes.length)} queues · {detected} detected · {manual} manual · sampled {formatNumber(flows.data.sampledJobs)} jobs
            </>
          ) : flows.isLoading ? (
            <Spinner label="Detecting flows…" />
          ) : null}
        </span>
        <div className="ml-auto flex items-center gap-2">
          <Button size="sm" variant="ghost" leftIcon={<RefreshCw />} onClick={() => flows.refetch()} loading={flows.isFetching}>
            Refresh
          </Button>
          <Button size="sm" variant="ghost" onClick={resetLayout}>
            Re-layout
          </Button>
          {isOperator && (
            <Button size="sm" variant="primary" leftIcon={<Plus />} onClick={() => setAdding(true)} disabled={!flows.data || flows.data.nodes.length < 2}>
              Add edge
            </Button>
          )}
        </div>
      </div>

      <div className="relative min-h-0 flex-1">
        {flows.isError && !flows.data && (
          <div className="absolute inset-0 z-10 flex items-center justify-center">
            <EmptyState title="Could not load flows" description={errorMessage(flows.error)} />
          </div>
        )}
        {flows.data && flows.data.nodes.length === 0 && (
          <div className="absolute inset-0 z-10 flex items-center justify-center">
            <EmptyState icon={<Workflow />} title="No queues on this connection" description="Flows are built from the queues discovered on the connection." />
          </div>
        )}
        <ReactFlow<QueueNode, FlowEdgeT>
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onNodeDragStop={(_, n) => moved.current.set(n.id, n.position)}
          onEdgeClick={(_, e) => {
            setSelectedEdge(e.data?.edge ?? null);
            setSelectedNode(null);
          }}
          onNodeClick={(_, n) => {
            setSelectedNode(n.data.node);
            setSelectedEdge(null);
          }}
          onPaneClick={() => {
            setSelectedEdge(null);
            setSelectedNode(null);
          }}
          onNodeDoubleClick={(_, n) => navigate(routes.queue(connectionId, n.data.node.queueName))}
          fitView
          fitViewOptions={{ padding: 0.2, maxZoom: 1 }}
          minZoom={0.2}
          maxZoom={1.75}
          nodesConnectable={false}
          proOptions={{ hideAttribution: true }}
          colorMode="system"
          className="bg-bg"
        >
          <Background variant={BackgroundVariant.Dots} gap={20} size={1} />
          <Controls showInteractive={false} position="bottom-right" />
          <MiniMap pannable zoomable position="bottom-left" nodeColor={() => "var(--surface-3)"} maskColor="color-mix(in srgb, var(--bg) 70%, transparent)" style={{ width: 160, height: 100 }} />
        </ReactFlow>

        {/* Legend + tip */}
        <div className="pointer-events-none absolute top-3 left-3 flex flex-col gap-2">
          <div className="pointer-events-auto rounded-md border border-border bg-surface/95 px-3 py-2 text-[11px] text-fg-muted shadow-sm">
            <div className="mb-1 font-semibold tracking-wider text-fg-subtle uppercase">Legend</div>
            <div className="flex items-center gap-2">
              <svg width="36" height="8">
                <line x1="0" y1="4" x2="36" y2="4" stroke="var(--fg-subtle)" strokeWidth="2" />
              </svg>
              detected · <span className="font-mono">×n</span> = jobs evidencing it
            </div>
            <div className="mt-1 flex items-center gap-2">
              <svg width="36" height="8">
                <line x1="0" y1="4" x2="36" y2="4" stroke="var(--accent)" strokeWidth="1.5" strokeDasharray="6 4" />
              </svg>
              manual edge
            </div>
            <div className="mt-1 flex items-center gap-2">
              <span className="inline-block h-3 w-9 rounded border border-dashed border-border-strong" /> paused queue
            </div>
          </div>
          <div className="pointer-events-auto flex max-w-sm items-start gap-2 rounded-md border border-border bg-surface/95 px-3 py-2 text-[11px] text-fg-muted shadow-sm">
            <Info className="mt-px size-3.5 shrink-0 text-info" aria-hidden />
            <span>
              Detected edges come from BullMQ flows: children carry a <span className="font-mono">parent</span> reference, so the arrow points from the child queue to the parent that waits for it. A worker that simply calls <span className="font-mono">otherQueue.add()</span> leaves no trace in Redis; draw those with a manual edge. Double-click a queue to open it.
            </span>
          </div>
        </div>

        {/* Selection panel */}
        {(selectedEdge || selectedNode) && (
          <div className="absolute top-3 right-3 w-72 rounded-lg border border-border bg-surface p-3 text-xs shadow-[var(--shadow)]">
            {selectedNode && (
              <>
                <div className="mb-2 flex items-center justify-between">
                  <span className="text-sm font-semibold">{selectedNode.queueName}</span>
                  {selectedNode.isPaused && <Badge variant="warning" size="xs">paused</Badge>}
                </div>
                <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-fg-muted">
                  {(Object.entries(selectedNode.counts) as [string, number][]).map(([k, v]) => (
                    <div key={k} className="flex justify-between border-b border-border/60 py-0.5">
                      <dt>{k}</dt>
                      <dd className="num text-fg">{formatNumber(v)}</dd>
                    </div>
                  ))}
                </dl>
                <Link to={routes.queue(connectionId, selectedNode.queueName)} className="mt-3 inline-flex items-center gap-1 text-accent hover:underline">
                  Open queue <ExternalLink className="size-3" />
                </Link>
              </>
            )}
            {selectedEdge && (
              <>
                <div className="mb-2 flex items-center gap-2">
                  <Link2 className="size-4 text-fg-subtle" aria-hidden />
                  <span className="font-mono text-[13px] font-semibold">
                    {selectedEdge.from} → {selectedEdge.to}
                  </span>
                </div>
                <div className="space-y-1 text-fg-muted">
                  <p>
                    Source: <Badge variant={selectedEdge.source === "manual" ? "accent" : "neutral"} size="xs">{selectedEdge.source}</Badge>
                  </p>
                  {selectedEdge.source === "detected" && <p>Evidence: {formatNumber(selectedEdge.evidence)} sampled jobs referenced this parent.</p>}
                  {selectedEdge.label && <p>Label: {selectedEdge.label}</p>}
                </div>
                {selectedEdge.source === "manual" && isOperator && (
                  <Button size="sm" variant="ghost" className="mt-3 hover:text-danger" leftIcon={<Trash2 />} loading={deleteEdge.isPending} onClick={() => deleteEdge.mutate(selectedEdge.id, { onSuccess: () => (setSelectedEdge(null), toast.success("Edge removed")), onError: (e) => toast.error(errorMessage(e)) })}>
                    Delete manual edge
                  </Button>
                )}
                {selectedEdge.source === "detected" && <p className="mt-2 text-fg-subtle">Detected edges disappear on their own once no sampled job references the parent.</p>}
              </>
            )}
          </div>
        )}
      </div>

      {flows.data && (
        <AddEdgeDialog
          open={adding}
          onClose={() => setAdding(false)}
          queues={flows.data.nodes.map((n) => n.queueName)}
          saving={createEdge.isPending}
          onSave={(from, to, label) =>
            createEdge.mutate({ connectionId, from, to, label: label || null }, { onSuccess: () => (setAdding(false), toast.success("Edge added")), onError: (e) => toast.error(errorMessage(e)) })
          }
        />
      )}
    </div>
  );
}

function AddEdgeDialog({ open, onClose, queues, onSave, saving }: { open: boolean; onClose: () => void; queues: string[]; onSave: (from: string, to: string, label: string) => void; saving: boolean }) {
  const sorted = useMemo(() => [...queues].sort((a, b) => a.localeCompare(b)), [queues]);
  const [from, setFrom] = useState(sorted[0] ?? "");
  const [to, setTo] = useState(sorted[1] ?? "");
  const [label, setLabel] = useState("");
  const same = from === to;
  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="sm"
      title="Add manual edge"
      description="Document a producer → consumer relationship that Redis cannot observe."
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" size="sm" disabled={same || !from || !to} loading={saving} onClick={() => onSave(from, to, label.trim())}>
            Add edge
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <Select label="From (producer)" value={from} onChange={(e) => setFrom(e.target.value)} options={sorted.map((q) => ({ value: q, label: q }))} />
        <Select label="To (consumer)" value={to} onChange={(e) => setTo(e.target.value)} options={sorted.map((q) => ({ value: q, label: q }))} error={same ? "Pick two different queues" : undefined} />
        <Input label="Label (optional)" value={label} onChange={(e) => setLabel(e.target.value)} maxLength={120} placeholder="e.g. enqueues on success" />
      </div>
    </Dialog>
  );
}
