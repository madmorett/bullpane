/**
 * Notification delivery: Slack incoming webhooks (Block Kit) and generic
 * webhooks (JSON POST + custom headers). 5 s timeout per attempt.
 */
import type { Alert, AlertChannel } from "@bullmq-visualizer/shared";

export const DELIVERY_TIMEOUT_MS = 5_000;

export interface AlertNotification {
  alert: Alert;
  status: "fired" | "resolved" | "test";
  message: string;
  value: number | null;
  threshold: number | null;
  queueName: string | null;
  connectionName: string | null;
  folderName: string | null;
  /** deep link into the dashboard */
  url: string;
}

export interface DeliveryResult {
  channel: string;
  ok: boolean;
  error: string | null;
}

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export function channelLabel(channel: AlertChannel): string {
  const raw = channel.type === "slack" ? channel.webhookUrl : channel.url;
  let host = "";
  try {
    host = new URL(raw).host;
  } catch {
    host = "invalid-url";
  }
  return `${channel.type} (${host})`;
}

export function alertLink(publicUrl: string, connectionId: string | null, queueName: string | null): string {
  const root = publicUrl.replace(/\/+$/, "");
  if (!connectionId) return `${root}/alerts`;
  const base = `${root}/c/${encodeURIComponent(connectionId)}`;
  return queueName ? `${base}/q/${encodeURIComponent(queueName)}` : base;
}

export function slackPayload(n: AlertNotification): Record<string, unknown> {
  const emoji = n.status === "fired" ? ":rotating_light:" : n.status === "resolved" ? ":white_check_mark:" : ":bell:";
  const title = `${emoji} ${n.status.toUpperCase()} — ${n.alert.name}`;
  const fields: Array<{ type: "mrkdwn"; text: string }> = [
    { type: "mrkdwn", text: `*Connection*\n${n.connectionName ?? "n/a"}` },
    { type: "mrkdwn", text: `*Queue*\n${n.queueName ?? "n/a"}${n.folderName ? ` · folder ${n.folderName}` : ""}` },
    { type: "mrkdwn", text: `*Condition*\n${n.alert.condition.kind}` },
    { type: "mrkdwn", text: `*Value / threshold*\n${n.value ?? "n/a"} / ${n.threshold ?? "n/a"}` },
  ];
  return {
    text: `${title}: ${n.message}`,
    blocks: [
      { type: "header", text: { type: "plain_text", text: title.slice(0, 150), emoji: true } },
      { type: "section", text: { type: "mrkdwn", text: n.message } },
      { type: "section", fields },
      {
        type: "actions",
        elements: [{ type: "button", text: { type: "plain_text", text: "Open in BullMQ Visualizer" }, url: n.url }],
      },
    ],
  };
}

export function webhookPayload(n: AlertNotification): Record<string, unknown> {
  return {
    alert: { id: n.alert.id, name: n.alert.name, kind: n.alert.condition.kind, condition: n.alert.condition, scope: n.alert.scope },
    event: n.status,
    connection: { id: n.alert.scope.type === "queue" ? n.alert.scope.connectionId : null, name: n.connectionName },
    queue: n.queueName,
    folder: n.folderName,
    value: n.value,
    threshold: n.threshold,
    status: n.status,
    message: n.message,
    url: n.url,
    sentAt: new Date().toISOString(),
  };
}

export async function deliverToChannel(
  channel: AlertChannel,
  notification: AlertNotification,
  fetchImpl: FetchLike = (url, init) => fetch(url, init),
): Promise<DeliveryResult> {
  const label = channelLabel(channel);
  const url = channel.type === "slack" ? channel.webhookUrl : channel.url;
  const body = channel.type === "slack" ? slackPayload(notification) : webhookPayload(notification);
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "user-agent": "bullmq-visualizer-alerts",
    ...(channel.type === "webhook" ? channel.headers ?? {} : {}),
  };
  try {
    const res = await fetchImpl(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
    });
    if (!res.ok) {
      const text = (await res.text().catch(() => "")).slice(0, 200);
      return { channel: label, ok: false, error: `HTTP ${res.status}${text ? `: ${text}` : ""}` };
    }
    return { channel: label, ok: true, error: null };
  } catch (err) {
    const message = err instanceof Error ? (err.name === "TimeoutError" ? "timed out after 5s" : err.message) : String(err);
    return { channel: label, ok: false, error: message };
  }
}

export async function deliverToAll(
  channels: AlertChannel[],
  notification: AlertNotification,
  fetchImpl?: FetchLike,
): Promise<DeliveryResult[]> {
  return Promise.all(channels.map((c) => deliverToChannel(c, notification, fetchImpl)));
}
