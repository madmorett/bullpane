/**
 * "Can this alert actually measure anything?" — the two bits of UI that keep the
 * dashboard honest about error alerts.
 *
 * `failed_above` / `failed_rate_above` are computed by diffing BullMQ's own
 * cumulative metrics counters between two evaluation ticks. That is the only
 * source that survives `removeOnComplete`: counting the completed/failed sorted
 * sets reports a healthy queue as failing (4.8% real reads as 23.1% once the
 * successes are pruned). A queue whose Worker does not collect metrics therefore
 * gets NO error alert — so the form must say so BEFORE saving, and the list must
 * never paint an inert alert green.
 */
import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, Clock } from "lucide-react";
import type { AlertMeasurement, Folder, FolderQueueRef, QueueSetup } from "@bullpane/shared";
import { useQueueSetup } from "@/api/hooks";
import { Badge } from "@/components/ui/Badge";
import { CodeBlock } from "@/components/ui/CodeBlock";
import { Tooltip } from "@/components/ui/Tooltip";

export const WORKER_METRICS_SNIPPET = `new Worker(name, fn, { metrics: { maxDataPoints: MetricsTime.ONE_WEEK } })`;

/** One queue's metrics status, as far as the dashboard can see it. */
type MetricsState = "loading" | "on" | "off" | "unknown";

function stateOf(setup: { data?: QueueSetup; isLoading: boolean; isError: boolean }): MetricsState {
  if (setup.isLoading) return "loading";
  if (setup.isError || !setup.data) return "unknown";
  return setup.data.metricsEnabled ? "on" : "off";
}

/**
 * Warning shown in the alert form when the selected QUEUE collects no metrics.
 * Saving is still allowed on purpose: the queue may start collecting later (a
 * deploy away), and blocking the save would just push people to a worse alert.
 */
export function QueueMetricsWarning({ connectionId, queueName }: { connectionId: string; queueName: string }) {
  const setup = useQueueSetup(connectionId || undefined, queueName || undefined, { enabled: !!connectionId && !!queueName });
  const state = stateOf(setup);
  if (state === "loading" || state === "on") return null;
  return (
    <MetricsCallout
      title={
        state === "off"
          ? `Queue "${queueName}" does not collect BullMQ metrics — this alert will stay inert`
          : `Could not read the setup of "${queueName}", so it is unknown whether it collects metrics`
      }
    />
  );
}

/**
 * Same warning for a FOLDER-scoped alert: names the queues in the folder that
 * cannot be measured, because a folder alert firing on 2 of 7 queues while 5 are
 * invisible is exactly the kind of half-truth this rewrite exists to kill.
 *
 * One `useQueueSetup` per queue would be a hook inside a loop (illegal once the
 * folder changes), so each queue gets a tiny child component that reports its
 * own state upward. Setup is cached 10 s on the server, so N queues cost N cheap
 * requests once per folder selection.
 */
export function FolderMetricsWarning({ folder }: { folder: Folder | undefined }) {
  const [states, setStates] = useState<Record<string, MetricsState>>({});
  const queues = folder?.queues ?? [];
  const key = (q: FolderQueueRef) => `${q.connectionId}/${q.queueName}`;

  // A different folder means a different set of probes: start from scratch so a
  // stale "off" from the previous folder cannot leak into this warning.
  useEffect(() => setStates({}), [folder?.id]);

  const report = useCallback((k: string, state: MetricsState) => {
    setStates((prev) => (prev[k] === state ? prev : { ...prev, [k]: state }));
  }, []);

  if (!folder || queues.length === 0) return null;
  const off = queues.filter((q) => states[key(q)] === "off").map((q) => q.queueName);
  const unknown = queues.filter((q) => states[key(q)] === "unknown").map((q) => q.queueName);
  const probes = queues.map((q) => <QueueMetricsProbe key={key(q)} id={key(q)} queue={q} onState={report} />);

  if (off.length === 0 && unknown.length === 0) return <>{probes}</>;
  const parts = [
    off.length > 0 ? `${off.length} of ${queues.length} queue(s) collect no metrics: ${off.join(", ")}` : null,
    unknown.length > 0 ? `could not read: ${unknown.join(", ")}` : null,
  ].filter(Boolean);
  return (
    <>
      {probes}
      <MetricsCallout title={`Folder "${folder.name}" — ${parts.join(" · ")}`} />
    </>
  );
}

/** Renders nothing; exists so each queue's setup query is its own component. */
function QueueMetricsProbe({
  id,
  queue,
  onState,
}: {
  id: string;
  queue: FolderQueueRef;
  onState: (id: string, state: MetricsState) => void;
}) {
  const setup = useQueueSetup(queue.connectionId, queue.queueName);
  const state = stateOf(setup);
  useEffect(() => onState(id, state), [id, state, onState]);
  return null;
}

function MetricsCallout({ title }: { title: string }) {
  return (
    <div className="space-y-2 rounded-md border border-warning/40 bg-warning/10 p-3" role="status">
      <p className="flex items-start gap-2 text-xs text-fg">
        <AlertTriangle className="mt-px size-4 shrink-0 text-warning" />
        <span>{title}</span>
      </p>
      <p className="text-xs text-fg-muted">
        Failure alerts are measured only from BullMQ's own metrics counters — the completed/failed sorted sets lie as soon as{" "}
        <code className="font-mono">removeOnComplete</code> prunes them. Turn metrics on in the worker and the alert starts measuring by itself:
      </p>
      <CodeBlock code={WORKER_METRICS_SNIPPET} language="ts" wrap maxHeight={80} />
    </div>
  );
}

/**
 * The State cell of the alerts list. `firing` and `off` are unchanged; the point
 * of this component is that an alert which cannot measure never renders as "ok".
 */
export function MeasurementBadge({ measurement }: { measurement: AlertMeasurement | null | undefined }) {
  if (!measurement) {
    return (
      <Tooltip content="Not evaluated yet — the server evaluates alerts every few seconds.">
        <Badge variant="neutral">pending</Badge>
      </Tooltip>
    );
  }
  if (measurement.state === "no_metrics") {
    return (
      <Tooltip content={`This queue collects no BullMQ metrics, so the alert cannot measure and will not fire. Enable it with ${WORKER_METRICS_SNIPPET}`}>
        <Badge variant="warning" dot>
          <AlertTriangle className="size-3" /> can't measure
        </Badge>
      </Tooltip>
    );
  }
  if (measurement.state === "warming_up") {
    return (
      <Tooltip content="Collecting counter history. The alert needs one sample older than its window before it can report a delta — after a server restart this takes one window.">
        <Badge variant="info" dot>
          <Clock className="size-3" /> warming up
        </Badge>
      </Tooltip>
    );
  }
  const partial = measurement.queuesWithoutMetrics?.length ?? 0;
  if (partial > 0) {
    return (
      <Tooltip content={`Measuring, but ${partial} queue(s) in the folder collect no metrics and are invisible to this alert: ${measurement.queuesWithoutMetrics?.join(", ")}`}>
        <Badge variant="warning" dot>
          partial
        </Badge>
      </Tooltip>
    );
  }
  return (
    <Tooltip content={measurement.source === "metrics" ? "Measured from BullMQ metrics counters." : "Measured from live queue counts."}>
      <Badge variant="success" dot>
        ok
      </Badge>
    </Tooltip>
  );
}
