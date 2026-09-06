import type { JobState } from "@bullmq-visualizer/shared";

const e = encodeURIComponent;

export const routes = {
  home: "/",
  login: "/login",
  setup: "/setup",
  connection: (cid: string) => `/c/${e(cid)}`,
  queue: (cid: string, q: string, state?: JobState) =>
    `/c/${e(cid)}/q/${e(q)}${state ? `?state=${state}` : ""}`,
  /** deep link that opens the queue with the job-data search focused */
  queueSearch: (cid: string, q: string, state?: JobState) =>
    `/c/${e(cid)}/q/${e(q)}?search=1${state ? `&state=${state}` : ""}`,
  job: (cid: string, q: string, id: string) => `/c/${e(cid)}/q/${e(q)}/j/${e(id)}`,
  groups: (cid: string, q: string) => `/c/${e(cid)}/q/${e(q)}/groups`,
  group: (cid: string, q: string, gid: string) => `/c/${e(cid)}/q/${e(q)}/groups/${e(gid)}`,
  /** per-queue metrics tab (charts + throughput), a sibling of the job-state tabs */
  queueMetrics: (cid: string, q: string) => `/c/${e(cid)}/q/${e(q)}/metrics`,
  health: "/health",
  folders: "/folders",
  /** folder dashboard: aggregate metrics + the folder's queues as cards */
  folder: (folderId: string) => `/folders/${e(folderId)}`,
  alerts: "/alerts",
  users: "/users",
  flows: (cid?: string) => (cid ? `/flows/${e(cid)}` : "/flows"),
  settings: (tab: "connections" | "license" | "about" = "connections") => `/settings/${tab}`,
};

/** queueKey "bull:orders" -> "orders"; handles prefixes with colons via the known prefix. */
export function queueNameFromKey(queueKey: string, prefix?: string): string {
  if (prefix && queueKey.startsWith(`${prefix}:`)) return queueKey.slice(prefix.length + 1);
  const idx = queueKey.indexOf(":");
  return idx >= 0 ? queueKey.slice(idx + 1) : queueKey;
}
