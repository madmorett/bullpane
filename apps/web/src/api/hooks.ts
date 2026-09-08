import {
  keepPreviousData,
  useInfiniteQuery,
  useMutation,
  useQueries,
  useQuery,
  useQueryClient,
  type UseQueryResult,
} from "@tanstack/react-query";
import type { z } from "zod";
import type {
  AddJobInput,
  Alert,
  BulkJobAction,
  BulkJobActionResult,
  AuditAction,
  AuditPage,
  ConnectionHealth,
  AlertEvent,
  CleanQueueInput,
  ConnectionStatus,
  CreateAlertInput,
  CreateConnectionInput,
  CreateUserInput,
  Edition,
  FlowEdge,
  FlowGraph,
  Folder,
  DiscoveryStatus,
  GroupsPage,
  HiddenQueue,
  JobDetail,
  JobSearchResult,
  JobState,
  JobsPage,
  MeResponse,
  QueueSetup,
  QueueSummary,
  SchedulersPage,
  RedisConnection,
  CreateSsoProviderInput,
  SsoLoginOptions,
  SsoProvider,
  SsoSettings,
  SsoTestResult,
  UpdateSsoProviderInput,
  RedisServerInfo,
  SetupStatus,
  UpdateConnectionInput,
  UpdateUserInput,
  User,
  createFlowEdgeSchema,
  createFolderSchema,
  setFolderQueuesSchema,
  testConnectionSchema,
  updateAlertSchema,
  updateFolderSchema,
} from "@bullpane/shared";
import { api, buildUrl, seg } from "./client";

// ---------------------------------------------------------------------------
// Shapes referenced by API.md that are not (yet) in @bullpane/shared.
// Kept deliberately loose and rendered defensively.
// ---------------------------------------------------------------------------

export interface HealthResponse {
  ok: boolean;
  version: string;
  uptime: number;
}

/** Response of POST /connections/test. Assumed to mirror ConnectionStatus. */
export interface PingResult extends Partial<ConnectionStatus> {
  ok: boolean;
  /** number of queues discovered during the test, when the server reports it */
  queuesFound?: number;
}

export interface ConnectionOverview {
  info: RedisServerInfo;
  /** visible queues only — hidden ones are filtered out server-side */
  queues: QueueSummary[];
  status: ConnectionStatus;
  /** how many queues were left out because they are hidden */
  hiddenCount?: number;
  /** SCAN progress; absent on older servers */
  discovery?: DiscoveryStatus;
}

export interface JobLogsResponse {
  logs: string[];
  count: number;
}


export interface AlertTestResult {
  ok: boolean;
  results: { channel: string; ok: boolean; error?: string | null }[];
}

export type JobActionKind = "retry" | "promote" | "remove" | "discard";
export type QueueActionKind =
  | "pause"
  | "resume"
  | "clean"
  | "retry-all"
  | "drain"
  | "obliterate";

export interface ListJobsParams {
  state: JobState;
  page: number;
  pageSize: number;
  order: "asc" | "desc";
  /** BullMQ Pro: page from the group's waiting list; the server ignores `state` when set */
  groupId?: string;
}
export interface SearchJobsParams {
  state: JobState;
  q: string;
  limit: number;
}
export interface PageParams {
  page: number;
  pageSize: number;
}

// ---------------------------------------------------------------------------
// Polling helper: pauses while the tab is hidden.
// ---------------------------------------------------------------------------
export const poll = (ms: number) => () =>
  typeof document !== "undefined" && document.hidden ? false : ms;

export const POLL = {
  queues: 5_000,
  queue: 3_000,
  job: 5_000,
  connections: 10_000,
  /** Redis health monitor. The server rate-limits INFO to one per 2 s per connection. */
  health: 3_000,
  setup: 10_000,
  slow: 15_000,
} as const;

// ---------------------------------------------------------------------------
// Query keys
// ---------------------------------------------------------------------------
export const qk = {
  health: ["health"] as const,
  edition: ["edition"] as const,
  setupStatus: ["setup-status"] as const,
  me: ["me"] as const,
  connections: ["connections"] as const,
  connectionsHealth: ["health", "connections"] as const,
  connectionHealth: (cid: string) => ["health", "connections", cid] as const,
  connection: (cid: string) => ["connections", cid] as const,
  overview: (cid: string) => ["connections", cid, "overview"] as const,
  queues: (cid: string) => ["connections", cid, "queues"] as const,
  queue: (cid: string, q: string) => ["connections", cid, "queue", q] as const,
  queueSetup: (cid: string, q: string) => ["connections", cid, "queue", q, "setup"] as const,
  jobs: (cid: string, q: string, p: ListJobsParams) =>
    ["connections", cid, "queue", q, "jobs", p] as const,
  jobSearch: (cid: string, q: string, p: SearchJobsParams) =>
    ["connections", cid, "queue", q, "search", p] as const,
  job: (cid: string, q: string, id: string) => ["connections", cid, "queue", q, "job", id] as const,
  jobLogs: (cid: string, q: string, id: string, range: { start?: number; end?: number }) =>
    ["connections", cid, "queue", q, "job", id, "logs", range] as const,
  groups: (cid: string, q: string, p: PageParams) =>
    ["connections", cid, "queue", q, "groups", p] as const,
  schedulers: (cid: string, q: string, p: PageParams) =>
    ["connections", cid, "queue", q, "schedulers", p] as const,
  groupJobs: (cid: string, q: string, gid: string, p: PageParams) =>
    ["connections", cid, "queue", q, "groups", gid, "jobs", p] as const,
  flows: (cid: string, sample: number) => ["flows", cid, sample] as const,
  hiddenQueues: (cid: string) => ["connections", cid, "hidden-queues"] as const,
  folders: ["folders"] as const,
  alerts: ["alerts"] as const,
  alertEvents: (p: { limit?: number; alertId?: string }) => ["alerts", "events", p] as const,
  users: ["users"] as const,
  ssoProviders: ["sso", "providers"] as const,
  ssoSettings: ["sso", "settings"] as const,
  ssoLoginOptions: ["sso", "login-options"] as const,
  audit: (p: AuditFilters & { limit?: number }) => ["audit", p] as const,
  auditActors: ["audit", "actors"] as const,
};

const queuePath = (cid: string, q: string) => `/connections/${seg(cid)}/queues/${seg(q)}`;

// ---------------------------------------------------------------------------
// Public / meta
// ---------------------------------------------------------------------------
export function useHealth() {
  return useQuery({
    queryKey: qk.health,
    queryFn: () => api.get<HealthResponse>("/health"),
    staleTime: 60_000,
  });
}

export function useEditionQuery(enabled = true) {
  return useQuery({
    queryKey: qk.edition,
    queryFn: () => api.get<Edition>("/edition"),
    enabled,
    staleTime: 60_000,
  });
}

export function useSetupStatus(enabled = true) {
  return useQuery({
    queryKey: qk.setupStatus,
    queryFn: () => api.get<SetupStatus>("/setup/status"),
    enabled,
    staleTime: 30_000,
  });
}

export function useMe(enabled = true) {
  return useQuery({
    queryKey: qk.me,
    queryFn: () => api.get<MeResponse>("/auth/me", { silent: [401] }),
    enabled,
    retry: false,
  });
}

// ---------------------------------------------------------------------------
// Connections
// ---------------------------------------------------------------------------
export function useConnections() {
  return useQuery({
    queryKey: qk.connections,
    queryFn: () => api.get<RedisConnection[]>("/connections"),
    refetchInterval: poll(POLL.connections),
  });
}

export function useConnectionOverview(cid: string | undefined) {
  return useQuery({
    queryKey: qk.overview(cid ?? ""),
    queryFn: () => api.get<ConnectionOverview>(`/connections/${seg(cid!)}/overview`),
    enabled: !!cid,
    refetchInterval: poll(POLL.queues),
    placeholderData: keepPreviousData,
  });
}

export interface ConnectionOverviewEntry {
  connection: RedisConnection;
  result: UseQueryResult<ConnectionOverview>;
}

export function useConnectionOverviews() {
  const connections = useConnections();
  const list = connections.data ?? [];
  const results = useQueries({
    queries: list.map((c) => ({
      queryKey: qk.overview(c.id),
      queryFn: () => api.get<ConnectionOverview>(`/connections/${seg(c.id)}/overview`),
      refetchInterval: poll(POLL.queues),
      placeholderData: keepPreviousData,
    })),
  });
  const entries: ConnectionOverviewEntry[] = list.map((connection, i) => ({
    connection,
    result: results[i] as UseQueryResult<ConnectionOverview>,
  }));
  return { connections, entries, isLoading: connections.isLoading };
}

export function useQueues(cid: string | undefined, opts: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: qk.queues(cid ?? ""),
    queryFn: () => api.get<QueueSummary[]>(`/connections/${seg(cid!)}/queues`),
    enabled: !!cid && (opts.enabled ?? true),
    refetchInterval: poll(POLL.queues),
    placeholderData: keepPreviousData,
  });
}

export interface ConnectionQueues {
  connection: RedisConnection;
  queues: QueueSummary[];
  isLoading: boolean;
  error: unknown;
}

/** Queue lists for every connection — powers the sidebar and the quick switcher. */
export function useAllQueues() {
  const connections = useConnections();
  const list = connections.data ?? [];
  const results = useQueries({
    queries: list.map((c) => ({
      queryKey: qk.queues(c.id),
      queryFn: () => api.get<QueueSummary[]>(`/connections/${seg(c.id)}/queues`),
      refetchInterval: poll(POLL.queues),
      placeholderData: keepPreviousData,
    })),
  });
  const byConnection: ConnectionQueues[] = list.map((connection, i) => ({
    connection,
    queues: (results[i]?.data as QueueSummary[] | undefined) ?? [],
    isLoading: !!results[i]?.isLoading,
    error: results[i]?.error,
  }));
  return {
    connections: list,
    byConnection,
    isLoading: connections.isLoading,
    error: connections.error,
  };
}

export function useRefreshQueues(cid: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      api.get<QueueSummary[]>(`/connections/${seg(cid!)}/queues`, { query: { refresh: 1 } }),
    onSuccess: (data) => {
      if (cid) qc.setQueryData(qk.queues(cid), data);
      qc.invalidateQueries({ queryKey: qk.connection(cid!) });
    },
  });
}

export function useQueue(cid: string | undefined, name: string | undefined) {
  return useQuery({
    queryKey: qk.queue(cid ?? "", name ?? ""),
    queryFn: () => api.get<QueueSummary>(queuePath(cid!, name!)),
    enabled: !!cid && !!name,
    refetchInterval: poll(POLL.queue),
    placeholderData: keepPreviousData,
  });
}

/**
 * GET /connections/:id/queues/:queue/setup — what Redis knows about the queue's
 * configuration (meta hash, limiter TTL, connected workers, group settings).
 * The server caches it for 10 s, so poll at the same cadence.
 */
export function useQueueSetup(cid: string | undefined, name: string | undefined, opts: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: qk.queueSetup(cid ?? "", name ?? ""),
    queryFn: () => api.get<QueueSetup>(`${queuePath(cid!, name!)}/setup`),
    enabled: !!cid && !!name && (opts.enabled ?? true),
    refetchInterval: poll(POLL.setup),
    placeholderData: keepPreviousData,
  });
}

// ---------------------------------------------------------------------------
// Jobs
// ---------------------------------------------------------------------------
export function useJobs(
  cid: string | undefined,
  queue: string | undefined,
  params: ListJobsParams,
  opts: { enabled?: boolean } = {},
) {
  return useQuery({
    queryKey: qk.jobs(cid ?? "", queue ?? "", params),
    queryFn: () =>
      api.get<JobsPage>(`${queuePath(cid!, queue!)}/jobs`, {
        query: { ...params },
      }),
    enabled: !!cid && !!queue && (opts.enabled ?? true),
    refetchInterval: poll(POLL.queue),
    placeholderData: keepPreviousData,
  });
}

export function useJobSearch(
  cid: string | undefined,
  queue: string | undefined,
  params: SearchJobsParams,
  opts: { enabled?: boolean } = {},
) {
  return useInfiniteQuery({
    queryKey: qk.jobSearch(cid ?? "", queue ?? "", params),
    queryFn: ({ pageParam }) =>
      api.get<JobSearchResult>(`${queuePath(cid!, queue!)}/jobs/search`, {
        query: { state: params.state, q: params.q, limit: params.limit, cursor: pageParam },
      }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled: !!cid && !!queue && params.q.trim().length > 0 && (opts.enabled ?? true),
    staleTime: 30_000,
  });
}

export function useJob(cid: string | undefined, queue: string | undefined, jobId: string | undefined) {
  return useQuery({
    queryKey: qk.job(cid ?? "", queue ?? "", jobId ?? ""),
    queryFn: () => api.get<JobDetail>(`${queuePath(cid!, queue!)}/jobs/${seg(jobId!)}`),
    enabled: !!cid && !!queue && !!jobId,
    refetchInterval: (query) => {
      if (typeof document !== "undefined" && document.hidden) return false;
      const d = query.state.data;
      if (d && d.finishedOn) return false;
      return POLL.job;
    },
  });
}

export function useJobLogs(
  cid: string | undefined,
  queue: string | undefined,
  jobId: string | undefined,
  range: { start?: number; end?: number } = {},
  enabled = true,
) {
  return useQuery({
    queryKey: qk.jobLogs(cid ?? "", queue ?? "", jobId ?? "", range),
    queryFn: () =>
      api.get<JobLogsResponse>(`${queuePath(cid!, queue!)}/jobs/${seg(jobId!)}/logs`, {
        query: { start: range.start, end: range.end },
      }),
    enabled: enabled && !!cid && !!queue && !!jobId,
    refetchInterval: poll(POLL.job),
  });
}

export function useJobAction(cid: string, queue: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ jobId, action }: { jobId: string; action: JobActionKind }) => {
      const base = `${queuePath(cid, queue)}/jobs/${seg(jobId)}`;
      if (action === "remove") return api.del<{ ok: boolean }>(base);
      return api.post<{ ok: boolean }>(`${base}/${action}`);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.queue(cid, queue) });
      qc.invalidateQueries({ queryKey: qk.queues(cid) });
      qc.invalidateQueries({ queryKey: qk.overview(cid) });
    },
  });
}

/**
 * Ações em lote. Uma chamada, resultado PARCIAL: `{ ok, failed }` com 200 mesmo
 * quando alguns ids não foram, porque o operador precisa saber quais 3 dos 50
 * ficaram para trás. O `onSuccess` invalida as mesmas queries da ação unitária.
 */
export function useBulkJobAction(cid: string, queue: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ action, jobIds }: { action: BulkJobAction; jobIds: string[] }) =>
      api.post<BulkJobActionResult>(`${queuePath(cid, queue)}/jobs/bulk/${action}`, { jobIds }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.queue(cid, queue) });
      qc.invalidateQueries({ queryKey: qk.queues(cid) });
      qc.invalidateQueries({ queryKey: qk.overview(cid) });
    },
  });
}

export function useAddJob(cid: string, queue: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: AddJobInput) =>
      api.post<{ id: string }>(`${queuePath(cid, queue)}/jobs`, input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.queue(cid, queue) });
      qc.invalidateQueries({ queryKey: qk.queues(cid) });
    },
  });
}

export type QueueActionInput =
  | { action: "pause" | "resume" | "obliterate" }
  | { action: "clean"; body: CleanQueueInput }
  | { action: "retry-all"; body: { state: "failed" | "completed" } }
  | { action: "drain"; body: { includeDelayed?: boolean } };

export function useQueueAction(cid: string, queue: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: QueueActionInput) => {
      const base = `${queuePath(cid, queue)}/${input.action}`;
      if ("body" in input) return api.post<{ ok?: boolean; removed?: number }>(base, input.body);
      return api.post<{ ok?: boolean; removed?: number }>(base);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.queue(cid, queue) });
      qc.invalidateQueries({ queryKey: qk.queues(cid) });
      qc.invalidateQueries({ queryKey: qk.overview(cid) });
    },
  });
}

/** Pause / resume from a list where the queue is not fixed. */
export function useQueueToggle(cid: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ queue, action }: { queue: string; action: "pause" | "resume" }) =>
      api.post<{ ok: boolean }>(`${queuePath(cid, queue)}/${action}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.connection(cid) });
    },
  });
}

// ---------------------------------------------------------------------------
// Groups (BullMQ Pro)
// ---------------------------------------------------------------------------
export function useGroups(cid: string | undefined, queue: string | undefined, params: PageParams) {
  return useQuery({
    queryKey: qk.groups(cid ?? "", queue ?? "", params),
    queryFn: () =>
      api.get<GroupsPage>(`${queuePath(cid!, queue!)}/groups`, { query: { ...params } }),
    enabled: !!cid && !!queue,
    refetchInterval: poll(POLL.queues),
    placeholderData: keepPreviousData,
  });
}

export function useGroupJobs(
  cid: string | undefined,
  queue: string | undefined,
  groupId: string | undefined,
  params: PageParams,
) {
  return useQuery({
    queryKey: qk.groupJobs(cid ?? "", queue ?? "", groupId ?? "", params),
    queryFn: () =>
      api.get<JobsPage>(`${queuePath(cid!, queue!)}/groups/${seg(groupId!)}/jobs`, {
        query: { ...params },
      }),
    enabled: !!cid && !!queue && !!groupId,
    refetchInterval: poll(POLL.queue),
    placeholderData: keepPreviousData,
  });
}

// ---------------------------------------------------------------------------
// Job schedulers (repeatable jobs)
// ---------------------------------------------------------------------------
export function useSchedulers(cid: string | undefined, queue: string | undefined, params: PageParams, opts: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: qk.schedulers(cid ?? "", queue ?? "", params),
    queryFn: () => api.get<SchedulersPage>(`${queuePath(cid!, queue!)}/schedulers`, { query: { ...params } }),
    enabled: !!cid && !!queue && opts.enabled !== false,
    refetchInterval: poll(POLL.queues),
    placeholderData: keepPreviousData,
  });
}

export function useRemoveScheduler(cid: string, queue: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (key: string) =>
      api.del<{ ok: boolean }>(`${queuePath(cid, queue)}/schedulers/${seg(key)}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["connections", cid, "queue", queue, "schedulers"] });
      // removing a scheduler also drops the delayed job it had queued
      qc.invalidateQueries({ queryKey: qk.queue(cid, queue) });
      qc.invalidateQueries({ queryKey: qk.queues(cid) });
    },
  });
}

// ---------------------------------------------------------------------------
// Connections CRUD (admin)
// ---------------------------------------------------------------------------
export function useCreateConnection() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateConnectionInput) =>
      api.post<RedisConnection>("/connections", input),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.connections }),
  });
}

export function useUpdateConnection() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: UpdateConnectionInput }) =>
      api.patch<RedisConnection>(`/connections/${seg(id)}`, input),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.connections }),
  });
}

export function useDeleteConnection() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.del<{ ok: boolean }>(`/connections/${seg(id)}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.connections }),
  });
}

export function useTestConnection() {
  return useMutation({
    mutationFn: (input: z.infer<typeof testConnectionSchema>) =>
      api.post<PingResult>("/connections/test", input),
  });
}

// ---------------------------------------------------------------------------
// Redis health monitor
//
// GET /health/connections returns one ConnectionHealth per configured
// connection. The server does the INFO sampling, the rate derivation and the
// warning thresholds, and rate-limits itself to one INFO per connection per
// 2 s regardless of how many tabs are open — so this hook just polls and
// renders. `enabled: false` (the pause toggle) stops our traffic entirely.
// ---------------------------------------------------------------------------
export function useConnectionsHealth(opts: { enabled?: boolean } = {}) {
  const enabled = opts.enabled ?? true;
  return useQuery({
    queryKey: qk.connectionsHealth,
    queryFn: () => api.get<ConnectionHealth[]>("/health/connections"),
    enabled,
    refetchInterval: enabled ? poll(POLL.health) : false,
    // Keep the last good frame on screen while the next one is in flight;
    // a monitor that blanks every 3 s is unreadable.
    placeholderData: keepPreviousData,
  });
}

export function useConnectionHealth(cid: string | undefined, opts: { enabled?: boolean } = {}) {
  const enabled = (opts.enabled ?? true) && !!cid;
  return useQuery({
    queryKey: qk.connectionHealth(cid ?? ""),
    queryFn: () => api.get<ConnectionHealth>(`/health/connections/${seg(cid!)}`),
    enabled,
    refetchInterval: enabled ? poll(POLL.health) : false,
    placeholderData: keepPreviousData,
  });
}

// ---------------------------------------------------------------------------
// Hidden queues (free)
//
// Every queue LIST in the app (`/queues`, `/overview`) is already filtered on
// the server, so the sidebar, the quick switcher, the folder picker and the
// alert queue selector all drop hidden queues without knowing this feature
// exists. These hooks only power the reveal UI and the hide/unhide actions.
// ---------------------------------------------------------------------------
export function useHiddenQueues(cid: string | undefined, opts: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: qk.hiddenQueues(cid ?? ""),
    queryFn: () => api.get<HiddenQueue[]>(`/connections/${seg(cid!)}/hidden-queues`),
    enabled: !!cid && (opts.enabled ?? true),
    staleTime: 30_000,
  });
}

/**
 * Hide / unhide. Both invalidate every queue list so the queue disappears from
 * (or comes back to) the sidebar, the cards and the table in one refresh.
 */
export function useSetQueueHidden(cid: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ queue, hidden }: { queue: string; hidden: boolean }) =>
      hidden
        ? api.post<HiddenQueue[]>(`/connections/${seg(cid)}/hidden-queues`, { queueName: queue })
        : api.del<HiddenQueue[]>(`/connections/${seg(cid)}/hidden-queues/${seg(queue)}`),
    onSuccess: (data) => {
      qc.setQueryData(qk.hiddenQueues(cid), data);
      qc.invalidateQueries({ queryKey: qk.queues(cid) });
      qc.invalidateQueries({ queryKey: qk.overview(cid) });
      qc.invalidateQueries({ queryKey: qk.connections });
    },
  });
}

// ---------------------------------------------------------------------------
// Folders (Pro)
// ---------------------------------------------------------------------------
export function useFolders(enabled = true) {
  return useQuery({
    queryKey: qk.folders,
    queryFn: () => api.get<Folder[]>("/folders", { silent: [402] }),
    enabled,
    staleTime: 30_000,
  });
}

export function useCreateFolder() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: z.input<typeof createFolderSchema>) => api.post<Folder>("/folders", input),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.folders }),
  });
}

export function useUpdateFolder() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: z.input<typeof updateFolderSchema> }) =>
      api.patch<Folder>(`/folders/${seg(id)}`, input),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.folders }),
  });
}

export function useDeleteFolder() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.del<{ ok: boolean }>(`/folders/${seg(id)}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.folders }),
  });
}

export function useSetFolderQueues() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: z.input<typeof setFolderQueuesSchema> }) =>
      api.put<Folder>(`/folders/${seg(id)}/queues`, input),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.folders }),
  });
}

// ---------------------------------------------------------------------------
// Alerts (Pro)
// ---------------------------------------------------------------------------
export function useAlerts(enabled = true) {
  return useQuery({
    queryKey: qk.alerts,
    queryFn: () => api.get<Alert[]>("/alerts", { silent: [402] }),
    enabled,
    refetchInterval: poll(POLL.connections),
  });
}

export function useAlertEvents(params: { limit?: number; alertId?: string } = {}, enabled = true) {
  return useQuery({
    queryKey: qk.alertEvents(params),
    queryFn: () =>
      api.get<AlertEvent[]>("/alerts/events", { query: { ...params }, silent: [402] }),
    enabled,
    refetchInterval: poll(POLL.connections),
  });
}

export function useCreateAlert() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateAlertInput) => api.post<Alert>("/alerts", input),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.alerts }),
  });
}

export function useUpdateAlert() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: z.input<typeof updateAlertSchema> }) =>
      api.patch<Alert>(`/alerts/${seg(id)}`, input),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.alerts }),
  });
}

export function useDeleteAlert() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.del<{ ok: boolean }>(`/alerts/${seg(id)}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.alerts }),
  });
}

export function useTestAlert() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.post<AlertTestResult>(`/alerts/${seg(id)}/test`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["alerts", "events"] }),
  });
}

// ---------------------------------------------------------------------------
// Users (Pro, admin)
// ---------------------------------------------------------------------------
export function useUsers(enabled = true) {
  return useQuery({
    queryKey: qk.users,
    queryFn: () => api.get<User[]>("/users", { silent: [402] }),
    enabled,
  });
}

export function useCreateUser() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateUserInput) => api.post<User>("/users", input),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.users }),
  });
}

export function useUpdateUser() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: UpdateUserInput }) =>
      api.patch<User>(`/users/${seg(id)}`, input),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.users }),
  });
}

export function useDeleteUser() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.del<{ ok: boolean }>(`/users/${seg(id)}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.users }),
  });
}

// ---------------------------------------------------------------------------
// Audit log (Pro, admin)
//
// Read-only by design: there is no create/update/delete hook because the API
// exposes none. An audit trail the UI can edit is not a trail.
// ---------------------------------------------------------------------------
export interface AuditFilters {
  actorId?: string;
  action?: AuditAction;
  connectionId?: string;
  queueName?: string;
  jobId?: string;
  result?: "ok" | "error";
  /** ISO datetime, inclusive */
  from?: string;
  /** ISO datetime, exclusive */
  to?: string;
}

export interface AuditActor {
  id: string | null;
  name: string | null;
  email: string | null;
}

/**
 * Keyset-paged (`nextCursor`), so page 40 of a million rows costs what page 1
 * does. No polling: an audit log read is a deliberate act, not a live feed, and
 * refetching it every 10 s would just churn.
 */
export function useAudit(filters: AuditFilters = {}, limit = 50, enabled = true) {
  return useInfiniteQuery({
    queryKey: qk.audit({ ...filters, limit }),
    queryFn: ({ pageParam }) =>
      api.get<AuditPage>("/audit", {
        query: { ...filters, limit, cursor: pageParam ?? undefined },
        silent: [402, 403],
      }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled,
  });
}

/**
 * Distinct actors present in the log — including people who have since been
 * deleted, which is exactly why the server denormalises the actor.
 */
export function useAuditActors(enabled = true) {
  return useQuery({
    queryKey: qk.auditActors,
    queryFn: () => api.get<AuditActor[]>("/audit/actors", { silent: [402, 403] }),
    enabled,
    staleTime: 60_000,
  });
}

/**
 * The CSV export URL. A plain link, not a fetch: the browser's own download
 * handles a 50k-row file without holding it in JS memory, and the session
 * cookie rides along.
 */
export function auditExportUrl(filters: AuditFilters = {}): string {
  return buildUrl("/audit/export", { ...filters });
}

/** History of one job, for the job detail page. */
export function useJobAudit(cid: string | undefined, queue: string | undefined, jobId: string | undefined, enabled = true) {
  const filters: AuditFilters = { connectionId: cid, queueName: queue, jobId };
  return useQuery({
    queryKey: qk.audit({ ...filters, limit: 20 }),
    queryFn: () => api.get<AuditPage>("/audit", { query: { ...filters, limit: 20 }, silent: [402, 403] }),
    enabled: enabled && !!cid && !!queue && !!jobId,
    staleTime: 15_000,
  });
}

// ---------------------------------------------------------------------------
// Flows (Pro)
// ---------------------------------------------------------------------------
export function useFlows(cid: string | undefined, sample = 200, enabled = true) {
  return useQuery({
    queryKey: qk.flows(cid ?? "", sample),
    queryFn: () =>
      api.get<FlowGraph>(`/connections/${seg(cid!)}/flows`, { query: { sample }, silent: [402] }),
    enabled: enabled && !!cid,
    refetchInterval: poll(POLL.connections),
    placeholderData: keepPreviousData,
  });
}

export function useCreateFlowEdge() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: z.input<typeof createFlowEdgeSchema>) =>
      api.post<FlowEdge>("/flow-edges", input),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["flows"] }),
  });
}

export function useDeleteFlowEdge() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.del<{ ok: boolean }>(`/flow-edges/${seg(id)}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["flows"] }),
  });
}

// ---------------------------------------------------------------------------
// License (admin)
// ---------------------------------------------------------------------------
export function useSetLicense() {
  return useMutation({
    mutationFn: (key: string) => api.put<Edition>("/license", { key }),
  });
}

export function useRefreshLicense() {
  return useMutation({
    mutationFn: () => api.post<Edition>("/license/refresh"),
  });
}

export function useRemoveLicense() {
  return useMutation({
    mutationFn: () => api.del<Edition>("/license"),
  });
}

// ---------------------------------------------------------------------------
// SSO (Pro)
// ---------------------------------------------------------------------------

/**
 * The login page's own query. Unauthenticated and never gated: on the free
 * edition the server answers with an empty provider list, so the page just
 * renders the password form. `silent: true` because a failure here must not
 * fire the global 401/402 handlers — nobody is logged in yet.
 */
export function useSsoLoginOptions() {
  return useQuery({
    queryKey: qk.ssoLoginOptions,
    queryFn: () => api.get<SsoLoginOptions>("/auth/sso/options", { silent: true }),
    staleTime: 60_000,
    retry: false,
  });
}

export function useSsoProviders(enabled = true) {
  return useQuery({
    queryKey: qk.ssoProviders,
    queryFn: () => api.get<SsoProvider[]>("/sso/providers", { silent: [402] }),
    enabled,
  });
}

export function useSsoSettings(enabled = true) {
  return useQuery({
    queryKey: qk.ssoSettings,
    queryFn: () => api.get<SsoSettings>("/sso/settings", { silent: [402] }),
    enabled,
  });
}

export function useCreateSsoProvider() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateSsoProviderInput) => api.post<SsoProvider>("/sso/providers", input),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.ssoProviders });
      // The login page's button list changes with it.
      void qc.invalidateQueries({ queryKey: qk.ssoLoginOptions });
    },
  });
}

export function useUpdateSsoProvider() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: UpdateSsoProviderInput }) =>
      api.patch<SsoProvider>(`/sso/providers/${seg(id)}`, input),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.ssoProviders });
      void qc.invalidateQueries({ queryKey: qk.ssoLoginOptions });
    },
  });
}

export function useDeleteSsoProvider() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.del<{ ok: true }>(`/sso/providers/${seg(id)}`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.ssoProviders });
      void qc.invalidateQueries({ queryKey: qk.ssoLoginOptions });
      // Deleting the last provider can flip requireSso's guard.
      void qc.invalidateQueries({ queryKey: qk.ssoSettings });
    },
  });
}

/** Discovery only — performs no login, so it is safe to click repeatedly. */
export function useTestSsoProvider() {
  return useMutation({
    mutationFn: (id: string) => api.post<SsoTestResult>(`/sso/providers/${seg(id)}/test`),
  });
}

export function useSetSsoSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: SsoSettings) => api.put<SsoSettings>("/sso/settings", input),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.ssoSettings });
      void qc.invalidateQueries({ queryKey: qk.ssoLoginOptions });
    },
  });
}
