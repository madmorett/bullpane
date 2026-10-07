/**
 * The MCP tools. Each one is a thin mapping onto an /api route (see internal.ts
 * for why), plus one that only builds a dashboard link.
 *
 * `access` decides who sees the tool in tools/list: a read-only connection is
 * not shown write tools at all, so the model does not plan around actions it
 * cannot take. The route's own role guard is still what enforces it.
 *
 * Drain, obliterate and clean are deliberately not tools. They destroy jobs in
 * bulk and cannot be undone, so the only thing the MCP does for them is hand
 * back a link that opens the confirmation dialog in the dashboard, where a human
 * reads the count and the queue name and clicks.
 *
 * Flow map tools let a client DRAW a process ("checkout → payment-capture →
 * email-send | pick-pack") for the team to see in the dashboard. They are drawings:
 * they never touch Redis, and they need write access like every other change.
 */
import { flowMapNodeId, JOB_STATES } from "@bullpane/shared";
import { z } from "zod";

export interface ApiCall {
  method: "GET" | "POST" | "PATCH" | "DELETE";
  url: string;
  body?: unknown;
}

export interface ToolContext {
  publicUrl: string;
  /** makes the /api call as the MCP caller; resolves to status + parsed body */
  call: (req: ApiCall) => Promise<{ status: number; body: unknown }>;
}

export interface ToolResult {
  content: { type: "text"; text: string }[];
  isError?: boolean;
}

type JsonSchema = Record<string, unknown>;

export interface McpTool {
  name: string;
  title: string;
  description: string;
  access: "read" | "write";
  inputSchema: JsonSchema;
  annotations: { readOnlyHint: boolean; destructiveHint: boolean; idempotentHint: boolean; openWorldHint: false };
  run(args: unknown, ctx: ToolContext): Promise<ToolResult>;
}

/** Big job payloads must not blow up the model's context; the dashboard has the rest. */
const MAX_TEXT = 100_000;

const seg = encodeURIComponent;
const queuePath = (a: { connection_id: string; queue: string }) => `/api/connections/${seg(a.connection_id)}/queues/${seg(a.queue)}`;
const jobPath = (a: { connection_id: string; queue: string; job_id: string }) => `${queuePath(a)}/jobs/${seg(a.job_id)}`;

function qs(params: Record<string, string | number | undefined>): string {
  const entries = Object.entries(params).filter(([, v]) => v !== undefined) as [string, string | number][];
  return entries.length ? `?${new URLSearchParams(entries.map(([k, v]): [string, string] => [k, String(v)])).toString()}` : "";
}

export function textResult(value: unknown, isError = false): ToolResult {
  let text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  if (text.length > MAX_TEXT) text = `${text.slice(0, MAX_TEXT)}\n… truncated at ${MAX_TEXT} characters; open the job in the dashboard for the rest.`;
  return { content: [{ type: "text", text }], ...(isError ? { isError: true } : {}) };
}

/** An /api answer as a tool result: errors become `isError` with the API's own message. */
async function forward(ctx: ToolContext, req: ApiCall): Promise<ToolResult> {
  const { status, body } = await ctx.call(req);
  return apiResult(status, body);
}

function apiResult(status: number, body: unknown): ToolResult {
  if (status >= 400) {
    const b = (body ?? {}) as { error?: string; message?: string };
    const hint =
      status === 403 ? " (MCP calls act with your role, capped to the access this connection was given: read = viewer, write = operator)" : "";
    return textResult(`${b.error ?? `HTTP ${status}`}: ${b.message ?? "request failed"}${hint}`, true);
  }
  return textResult(body);
}

// ---------------------------------------------------------------------------
// Argument schemas (zod validates; the JSON Schema is what the client sees)
// ---------------------------------------------------------------------------

const str = (description: string, extra: JsonSchema = {}): JsonSchema => ({ type: "string", description, ...extra });
const int = (description: string, min: number, max: number): JsonSchema => ({ type: "integer", description, minimum: min, maximum: max });
const object = (properties: Record<string, JsonSchema>, required: string[]): JsonSchema => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});

const CONNECTION = { connection_id: str("Connection id, from list_connections") };
const QUEUE = { ...CONNECTION, queue: str("Queue name, from list_queues") };
const JOB = { ...QUEUE, job_id: str("Job id") };

const zConn = z.object({ connection_id: z.string().min(1) });
const zQueue = zConn.extend({ queue: z.string().min(1) });
const zJob = zQueue.extend({ job_id: z.string().min(1) });
const zState = z.enum(JOB_STATES);
const zMap = z.object({ map_id: z.string().min(1) });
const mapPath = (a: { map_id: string }) => `/api/flow-maps/${seg(a.map_id)}`;

/**
 * The connection a flow map tool means when the client left connection_id out:
 * the only one, when there is exactly one. With several, guessing would draw the
 * wrong queue (the same name may exist on two connections), so the client is
 * told to pass it.
 */
async function connectionOrDefault(ctx: ToolContext, given: string | undefined): Promise<{ id: string } | { error: ToolResult }> {
  if (given) return { id: given };
  const res = await ctx.call({ method: "GET", url: "/api/connections" });
  if (res.status >= 400) return { error: apiResult(res.status, res.body) };
  const list = Array.isArray(res.body) ? (res.body as Array<{ id: string; name: string }>) : [];
  if (list.length === 1) return { id: (list[0] as { id: string }).id };
  if (list.length === 0) return { error: textResult("validation: Bullpane has no connection yet; add one in the dashboard first.", true) };
  const names = list.map((c) => `${c.name} (${c.id})`).join(", ");
  return {
    error: textResult(
      `validation: connection_id is required: this installation has ${list.length} connections (${names}). Pass the connection of each queue; list_connections shows them.`,
      true,
    ),
  };
}

const ro = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
const rw = (destructive: boolean, idempotent: boolean) => ({ readOnlyHint: false, destructiveHint: destructive, idempotentHint: idempotent, openWorldHint: false }) as const;

function tool<T extends z.ZodTypeAny>(
  def: Omit<McpTool, "run"> & { schema: T; run: (args: z.infer<T>, ctx: ToolContext) => Promise<ToolResult> },
): McpTool {
  const { schema, run, ...rest } = def;
  return {
    ...rest,
    async run(args, ctx) {
      const parsed = schema.safeParse(args ?? {});
      if (!parsed.success) {
        return textResult(`Invalid arguments: ${parsed.error.issues.map((i) => `${i.path.join(".") || "arguments"}: ${i.message}`).join("; ")}`, true);
      }
      return run(parsed.data, ctx);
    },
  };
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

export const MCP_TOOLS: McpTool[] = [
  // ----- read -----
  tool({
    name: "list_connections",
    title: "List Redis connections",
    description: "Lists the Redis connections configured in Bullpane, with their status. Start here: every other tool needs a connection_id.",
    access: "read",
    inputSchema: object({}, []),
    annotations: ro,
    schema: z.object({}),
    run: (_a, ctx) => forward(ctx, { method: "GET", url: "/api/connections" }),
  }),
  tool({
    name: "list_queues",
    title: "List queues",
    description:
      "Lists the BullMQ queues of a connection with job counts per state (waiting, active, delayed, failed, completed…), paused flag and worker count. The queue list is cached; pass refresh: true only when a queue you expect is missing.",
    access: "read",
    inputSchema: object({ ...CONNECTION, refresh: { type: "boolean", description: "Rediscover queues now (a bounded Redis scan, honoured at most every 5 s). Only when one is missing." } }, ["connection_id"]),
    annotations: ro,
    schema: zConn.extend({ refresh: z.boolean().optional() }),
    run: (a, ctx) => forward(ctx, { method: "GET", url: `/api/connections/${seg(a.connection_id)}/queues${a.refresh ? "?refresh=1" : ""}` }),
  }),
  tool({
    name: "get_queue",
    title: "Get queue",
    description: "One queue: counts per state, paused flag, workers and throughput/failure metrics.",
    access: "read",
    inputSchema: object(QUEUE, ["connection_id", "queue"]),
    annotations: ro,
    schema: zQueue,
    run: (a, ctx) => forward(ctx, { method: "GET", url: queuePath(a) }),
  }),
  tool({
    name: "list_jobs",
    title: "List jobs",
    description: "Lists jobs of a queue in one state, newest first by default. Job data is a truncated preview; use get_job for the full job.",
    access: "read",
    inputSchema: object(
      {
        ...QUEUE,
        state: str("Job state", { enum: [...JOB_STATES], default: "waiting" }),
        page: int("Page, from 1", 1, 10_000),
        page_size: int("Jobs per page", 1, 200),
        order: str("Sort order by time", { enum: ["asc", "desc"] }),
      },
      ["connection_id", "queue"],
    ),
    annotations: ro,
    schema: zQueue.extend({
      state: zState.optional(),
      page: z.number().int().min(1).optional(),
      page_size: z.number().int().min(1).max(200).optional(),
      order: z.enum(["asc", "desc"]).optional(),
    }),
    run: (a, ctx) =>
      forward(ctx, { method: "GET", url: `${queuePath(a)}/jobs${qs({ state: a.state, page: a.page, pageSize: a.page_size, order: a.order })}` }),
  }),
  tool({
    name: "search_jobs",
    title: "Search jobs",
    description:
      "Searches the jobs of one state for a text in the job id, name, data or failure reason. With group_id (BullMQ Pro) only that group's jobs are returned and query may be omitted: this is how to list a group's delayed, failed or completed jobs, which list_groups does not count. Scans in pages: pass next_cursor back as cursor to continue.",
    access: "read",
    inputSchema: object(
      {
        ...QUEUE,
        query: str("Text to look for (optional with group_id)"),
        group_id: str("BullMQ Pro group id (exact): only jobs of this group"),
        state: str("Job state to search", { enum: [...JOB_STATES], default: "failed" }),
        cursor: str("Cursor from a previous call's nextCursor"),
        limit: int("Max matches", 1, 200),
      },
      ["connection_id", "queue"],
    ),
    annotations: ro,
    schema: zQueue
      .extend({
        query: z.string().max(500).optional(),
        group_id: z.string().min(1).max(200).optional(),
        state: zState.optional(),
        cursor: z.string().optional(),
        limit: z.number().int().min(1).max(200).optional(),
      })
      .refine((a) => !!a.query || !!a.group_id, { message: "query or group_id is required", path: ["query"] }),
    run: (a, ctx) =>
      forward(ctx, {
        method: "GET",
        url: `${queuePath(a)}/jobs/search${qs({ q: a.query || undefined, groupId: a.group_id, state: a.state, cursor: a.cursor, limit: a.limit })}`,
      }),
  }),
  tool({
    name: "get_job",
    title: "Get job",
    description: "One job in full: data, options, state, attempts, failure reason, stack trace, return value and parent.",
    access: "read",
    inputSchema: object(JOB, ["connection_id", "queue", "job_id"]),
    annotations: ro,
    schema: zJob,
    run: (a, ctx) => forward(ctx, { method: "GET", url: jobPath(a) }),
  }),
  tool({
    name: "get_job_logs",
    title: "Get job logs",
    description: "The log lines a worker wrote for a job (job.log), paged by line index.",
    access: "read",
    inputSchema: object({ ...JOB, start: int("First line", 0, 1_000_000), end: int("Last line", 0, 1_000_000) }, ["connection_id", "queue", "job_id"]),
    annotations: ro,
    schema: zJob.extend({ start: z.number().int().min(0).optional(), end: z.number().int().min(0).optional() }),
    run: (a, ctx) => forward(ctx, { method: "GET", url: `${jobPath(a)}/logs${qs({ start: a.start, end: a.end })}` }),
  }),
  tool({
    name: "list_schedulers",
    title: "List job schedulers",
    description: "The job schedulers (repeatable jobs) of a queue: pattern or interval, next run, template.",
    access: "read",
    inputSchema: object({ ...QUEUE, page: int("Page, from 1", 1, 10_000), page_size: int("Per page", 1, 200) }, ["connection_id", "queue"]),
    annotations: ro,
    schema: zQueue.extend({ page: z.number().int().min(1).optional(), page_size: z.number().int().min(1).max(200).optional() }),
    run: (a, ctx) => forward(ctx, { method: "GET", url: `${queuePath(a)}/schedulers${qs({ page: a.page, pageSize: a.page_size })}` }),
  }),
  tool({
    name: "list_groups",
    title: "List groups (BullMQ Pro)",
    description:
      "BullMQ Pro groups of a queue: status (rate limited, paused, maxed), waiting and active per group. Empty on plain BullMQ. Delayed jobs are not under their group in Pro, so a group with only delayed jobs is not listed: use search_jobs with group_id and state delayed.",
    access: "read",
    inputSchema: object({ ...QUEUE, page: int("Page, from 1", 1, 10_000), page_size: int("Per page", 1, 200) }, ["connection_id", "queue"]),
    annotations: ro,
    schema: zQueue.extend({ page: z.number().int().min(1).optional(), page_size: z.number().int().min(1).max(200).optional() }),
    run: (a, ctx) => forward(ctx, { method: "GET", url: `${queuePath(a)}/groups${qs({ page: a.page, pageSize: a.page_size })}` }),
  }),

  // ----- write (operator) -----
  tool({
    name: "add_job",
    title: "Add job",
    description: "Adds a job to a queue through BullMQ (queue.add). Recorded in the audit log.",
    access: "write",
    inputSchema: object(
      { ...QUEUE, name: str("Job name"), data: { description: "Job data (any JSON)" }, opts: { type: "object", description: "BullMQ JobsOptions (delay, attempts, priority…)" } },
      ["connection_id", "queue", "name"],
    ),
    annotations: rw(false, false),
    schema: zQueue.extend({ name: z.string().min(1).max(200), data: z.unknown().optional(), opts: z.record(z.unknown()).optional() }),
    run: (a, ctx) => forward(ctx, { method: "POST", url: `${queuePath(a)}/jobs`, body: { name: a.name, data: a.data ?? {}, opts: a.opts ?? {} } }),
  }),
  tool({
    name: "retry_job",
    title: "Retry job",
    description: "Moves a failed or completed job back to waiting so a worker runs it again.",
    access: "write",
    inputSchema: object(JOB, ["connection_id", "queue", "job_id"]),
    annotations: rw(false, false),
    schema: zJob,
    run: (a, ctx) => forward(ctx, { method: "POST", url: `${jobPath(a)}/retry` }),
  }),
  tool({
    name: "promote_job",
    title: "Promote job",
    description:
      "Runs a delayed job now. For a job created by a job scheduler, scheduler_mode decides what happens to the schedule: run_copy (default) runs a one-off copy and keeps the next scheduled run; skip_next runs the scheduled job early and nothing runs at its original time.",
    access: "write",
    inputSchema: object({ ...JOB, scheduler_mode: str("Only for a job scheduler's job", { enum: ["run_copy", "skip_next"] }) }, [
      "connection_id",
      "queue",
      "job_id",
    ]),
    annotations: rw(false, false),
    schema: zJob.extend({ scheduler_mode: z.enum(["run_copy", "skip_next"]).optional() }),
    run: (a, ctx) =>
      forward(ctx, { method: "POST", url: `${jobPath(a)}/promote`, body: a.scheduler_mode ? { scheduler: a.scheduler_mode } : {} }),
  }),
  tool({
    name: "remove_job",
    title: "Remove job",
    description: "Deletes one job. Cannot be undone.",
    access: "write",
    inputSchema: object(JOB, ["connection_id", "queue", "job_id"]),
    annotations: rw(true, true),
    schema: zJob,
    run: (a, ctx) => forward(ctx, { method: "DELETE", url: jobPath(a) }),
  }),
  tool({
    name: "discard_job",
    title: "Discard active job",
    description: "Moves a stuck active job to failed without retrying it (the operator 'discard').",
    access: "write",
    inputSchema: object(JOB, ["connection_id", "queue", "job_id"]),
    annotations: rw(false, true),
    schema: zJob,
    run: (a, ctx) => forward(ctx, { method: "POST", url: `${jobPath(a)}/discard` }),
  }),
  tool({
    name: "bulk_job_action",
    title: "Retry, promote or remove many jobs",
    description: "Applies retry, promote or remove to up to 500 job ids at once. Partial results: the answer lists which ids failed and why.",
    access: "write",
    inputSchema: object(
      { ...QUEUE, action: str("Action", { enum: ["retry", "promote", "remove"] }), job_ids: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 500 } },
      ["connection_id", "queue", "action", "job_ids"],
    ),
    annotations: rw(true, false),
    schema: zQueue.extend({ action: z.enum(["retry", "promote", "remove"]), job_ids: z.array(z.string().min(1)).min(1).max(500) }),
    run: (a, ctx) => forward(ctx, { method: "POST", url: `${queuePath(a)}/jobs/bulk/${a.action}`, body: { jobIds: a.job_ids } }),
  }),
  tool({
    name: "retry_all",
    title: "Retry every failed (or completed) job",
    description: "Moves every job in the failed (or completed) state of a queue back to waiting.",
    access: "write",
    inputSchema: object({ ...QUEUE, state: str("Which jobs to retry", { enum: ["failed", "completed"], default: "failed" }) }, ["connection_id", "queue"]),
    annotations: rw(false, false),
    schema: zQueue.extend({ state: z.enum(["failed", "completed"]).default("failed") }),
    run: (a, ctx) => forward(ctx, { method: "POST", url: `${queuePath(a)}/retry-all`, body: { state: a.state } }),
  }),
  tool({
    name: "pause_queue",
    title: "Pause queue",
    description: "Pauses a queue: workers stop picking new jobs. The reason goes to the audit log.",
    access: "write",
    inputSchema: object({ ...QUEUE, reason: str("Why, for the audit log") }, ["connection_id", "queue"]),
    annotations: rw(false, true),
    schema: zQueue.extend({ reason: z.string().max(500).optional() }),
    run: (a, ctx) => forward(ctx, { method: "POST", url: `${queuePath(a)}/pause`, body: a.reason ? { reason: a.reason } : {} }),
  }),
  tool({
    name: "resume_queue",
    title: "Resume queue",
    description: "Resumes a paused queue.",
    access: "write",
    inputSchema: object(QUEUE, ["connection_id", "queue"]),
    annotations: rw(false, true),
    schema: zQueue,
    run: (a, ctx) => forward(ctx, { method: "POST", url: `${queuePath(a)}/resume` }),
  }),

  tool({
    name: "promote_matching",
    title: "Promote every matching delayed job",
    description:
      "Promotes the delayed jobs of a BullMQ Pro group (group_id) and / or whose id, name or data contains query, beyond the 500-id limit of bulk_job_action. Each call acts on at most 2000 and returns next_cursor: call again with it until it is null. Grouped jobs go back into their group (needs BullMQ Pro's package next to Bullpane). With spread_from and spread_until (unix ms, at most 7 days apart) the jobs are rescheduled evenly over that window instead, soonest first, never later than they were: pass spread_total from count_matching and spread_offset = jobs matched by earlier calls.",
    access: "write",
    inputSchema: object(
      {
        ...QUEUE,
        query: str("Text the job id, name or data must contain"),
        group_id: str("BullMQ Pro group id (exact)"),
        cursor: str("next_cursor of the previous call"),
        spread_from: int("Spread: window start, unix ms", 0, Number.MAX_SAFE_INTEGER),
        spread_until: int("Spread: window end, unix ms", 0, Number.MAX_SAFE_INTEGER),
        spread_total: int("Spread: matching jobs in all (count_matching)", 1, Number.MAX_SAFE_INTEGER),
        spread_offset: int("Spread: jobs matched by earlier calls", 0, Number.MAX_SAFE_INTEGER),
      },
      ["connection_id", "queue"],
    ),
    annotations: rw(false, false),
    schema: zQueue
      .extend({
        query: z.string().max(500).optional(),
        group_id: z.string().min(1).max(200).optional(),
        cursor: z.string().max(300).optional(),
        spread_from: z.number().int().nonnegative().optional(),
        spread_until: z.number().int().nonnegative().optional(),
        spread_total: z.number().int().min(1).optional(),
        spread_offset: z.number().int().nonnegative().optional(),
      })
      .refine((a) => !!a.query?.trim() || !!a.group_id, { message: "query or group_id is required", path: ["query"] })
      .refine((a) => (a.spread_from === undefined) === (a.spread_until === undefined), { message: "spread_from and spread_until go together", path: ["spread_until"] }),
    run: (a, ctx) =>
      forward(ctx, {
        method: "POST",
        url: `${queuePath(a)}/jobs/promote-matching`,
        body: {
          query: a.query,
          groupId: a.group_id,
          cursor: a.cursor,
          ...(a.spread_from !== undefined && a.spread_until !== undefined
            ? { spread: { from: a.spread_from, until: a.spread_until, total: a.spread_total ?? 1, offset: a.spread_offset ?? 0 } }
            : {}),
        },
      }),
  }),
  tool({
    name: "count_matching",
    title: "Count matching delayed jobs",
    description:
      "How many delayed jobs promote_matching would act on: the jobs of a BullMQ Pro group (group_id) and / or whose id, name or data contains query. Read only. Returns next_cursor while part of the delayed state is uncounted: add up the calls.",
    access: "read",
    inputSchema: object({ ...QUEUE, query: str("Text the job id, name or data must contain"), group_id: str("BullMQ Pro group id (exact)"), cursor: str("next_cursor of the previous call") }, ["connection_id", "queue"]),
    annotations: ro,
    schema: zQueue
      .extend({ query: z.string().max(500).optional(), group_id: z.string().min(1).max(200).optional(), cursor: z.string().max(300).optional() })
      .refine((a) => !!a.query?.trim() || !!a.group_id, { message: "query or group_id is required", path: ["query"] }),
    run: (a, ctx) =>
      forward(ctx, { method: "GET", url: `${queuePath(a)}/jobs/count-matching${qs({ query: a.query || undefined, groupId: a.group_id, cursor: a.cursor })}` }),
  }),
  tool({
    name: "pause_group",
    title: "Pause a group (BullMQ Pro)",
    description: "Pauses one BullMQ Pro group: its jobs keep arriving, none are processed. Needs BullMQ Pro's package installed next to Bullpane.",
    access: "write",
    inputSchema: object({ ...QUEUE, group_id: str("Group id") }, ["connection_id", "queue", "group_id"]),
    annotations: rw(false, true),
    schema: zQueue.extend({ group_id: z.string().min(1).max(200) }),
    run: (a, ctx) => forward(ctx, { method: "POST", url: `${queuePath(a)}/groups/${seg(a.group_id)}/pause` }),
  }),
  tool({
    name: "resume_group",
    title: "Resume a group (BullMQ Pro)",
    description: "Resumes a paused BullMQ Pro group. Needs BullMQ Pro's package installed next to Bullpane.",
    access: "write",
    inputSchema: object({ ...QUEUE, group_id: str("Group id") }, ["connection_id", "queue", "group_id"]),
    annotations: rw(false, true),
    schema: zQueue.extend({ group_id: z.string().min(1).max(200) }),
    run: (a, ctx) => forward(ctx, { method: "POST", url: `${queuePath(a)}/groups/${seg(a.group_id)}/resume` }),
  }),

  // ----- flow maps (Pro): drawings of a process, read and write -----
  tool({
    name: "list_flow_maps",
    title: "List flow maps",
    description:
      "Lists the flow maps: named diagrams of the queues one process goes through. kind manual = drawn by people (nested by parentId, like folders); kind detected = computed, read-only, one per group of queues linked by BullMQ FlowProducer parents. Use get_flow_map for a map's queues, arrows and live counts.",
    access: "read",
    inputSchema: object({}, []),
    annotations: ro,
    schema: z.object({}),
    run: (_a, ctx) => forward(ctx, { method: "GET", url: "/api/flow-maps" }),
  }),
  tool({
    name: "get_flow_map",
    title: "Get flow map",
    description:
      "One flow map: its queues (node id = connectionId:queueName) with live job counts, and its arrows (edges, from → to). source manual = drawn, with an edge id for remove_flow_edge; source detected = seen in BullMQ flows, not removable. missing: true means the queue was not found on its connection.",
    access: "read",
    inputSchema: object({ map_id: str("Flow map id, from list_flow_maps") }, ["map_id"]),
    annotations: ro,
    schema: zMap,
    run: (a, ctx) => forward(ctx, { method: "GET", url: mapPath(a) }),
  }),
  tool({
    name: "create_flow_map",
    title: "Create flow map",
    description:
      "Creates an empty flow map to draw a process on. Then call add_flow_edge once per hop (work goes from_queue → to_queue): queues not on the map yet are added automatically, so the edges alone draw the whole process. Use add_flow_queue only for a queue with no arrow. parent_id nests it under another map.",
    access: "write",
    inputSchema: object(
      { name: str("Map name, e.g. the process: Checkout", { maxLength: 80 }), description: str("What the process does", { maxLength: 500 }), parent_id: str("Manual map to nest it under") },
      ["name"],
    ),
    annotations: rw(false, false),
    schema: z.object({ name: z.string().trim().min(1).max(80), description: z.string().max(500).optional(), parent_id: z.string().min(1).optional() }),
    run: (a, ctx) => forward(ctx, { method: "POST", url: "/api/flow-maps", body: { name: a.name, description: a.description, parentId: a.parent_id } }),
  }),
  tool({
    name: "update_flow_map",
    title: "Rename or move flow map",
    description: "Renames a manual flow map, changes its description, or moves it under another map (parent_id; null moves it to the top level). Detected maps are read-only: copy_flow_map them first.",
    access: "write",
    inputSchema: object(
      {
        map_id: str("Flow map id"),
        name: str("New name", { maxLength: 80 }),
        description: { type: ["string", "null"], description: "New description; null clears it" },
        parent_id: { type: ["string", "null"], description: "Map to move it under; null = top level" },
      },
      ["map_id"],
    ),
    annotations: rw(false, true),
    schema: zMap.extend({ name: z.string().trim().min(1).max(80).optional(), description: z.string().max(500).nullable().optional(), parent_id: z.string().min(1).nullable().optional() }),
    run: (a, ctx) => forward(ctx, { method: "PATCH", url: mapPath(a), body: { name: a.name, description: a.description, parentId: a.parent_id } }),
  }),
  tool({
    name: "delete_flow_map",
    title: "Delete flow map",
    description: "Deletes a manual flow map and its drawing. Only the drawing: no queue or job is touched. Maps nested under it move up one level.",
    access: "write",
    inputSchema: object({ map_id: str("Flow map id") }, ["map_id"]),
    annotations: rw(true, true),
    schema: zMap,
    run: (a, ctx) => forward(ctx, { method: "DELETE", url: mapPath(a) }),
  }),
  tool({
    name: "add_flow_queue",
    title: "Add queue to flow map",
    description:
      "Puts a queue on a manual flow map. Idempotent. Not needed for queues that have an arrow: add_flow_edge adds both ends. The queue does not have to exist yet (it shows as missing). connection_id may be omitted when Bullpane has exactly one connection.",
    access: "write",
    inputSchema: object({ map_id: str("Flow map id"), queue: str("Queue name"), connection_id: str("Connection of the queue, from list_connections (optional with a single connection)") }, ["map_id", "queue"]),
    annotations: rw(false, true),
    schema: zMap.extend({ queue: z.string().min(1).max(255), connection_id: z.string().min(1).optional() }),
    run: async (a, ctx) => {
      const conn = await connectionOrDefault(ctx, a.connection_id);
      if ("error" in conn) return conn.error;
      return forward(ctx, { method: "POST", url: `${mapPath(a)}/nodes`, body: { connectionId: conn.id, queueName: a.queue } });
    },
  }),
  tool({
    name: "remove_flow_queue",
    title: "Remove queue from flow map",
    description: "Takes a queue off a manual flow map, with the drawn arrows touching it. Only the drawing: the queue itself is untouched. connection_id may be omitted when Bullpane has exactly one connection.",
    access: "write",
    inputSchema: object({ map_id: str("Flow map id"), queue: str("Queue name"), connection_id: str("Connection of the queue (optional with a single connection)") }, ["map_id", "queue"]),
    annotations: rw(true, true),
    schema: zMap.extend({ queue: z.string().min(1).max(255), connection_id: z.string().min(1).optional() }),
    run: async (a, ctx) => {
      const conn = await connectionOrDefault(ctx, a.connection_id);
      if ("error" in conn) return conn.error;
      return forward(ctx, { method: "DELETE", url: `${mapPath(a)}/nodes/${seg(flowMapNodeId({ connectionId: conn.id, queueName: a.queue }))}` });
    },
  }),
  tool({
    name: "add_flow_edge",
    title: "Draw an arrow on a flow map",
    description:
      "Draws one hop of a process on a manual flow map: work goes from from_queue to to_queue (the producer side to the consumer side). Call it once per hop; queues not on the map yet are added automatically. Idempotent: drawing the same arrow again only updates its label. The two queues may be on different connections (another Redis, or Postgres): pass from_connection_id and to_connection_id. Each may be omitted only when Bullpane has exactly one connection.",
    access: "write",
    inputSchema: object(
      {
        map_id: str("Flow map id"),
        from_queue: str("Queue the work comes from"),
        to_queue: str("Queue the work goes to"),
        label: str("Short text on the arrow, e.g. 'per item' or 'on failure'", { maxLength: 120 }),
        from_connection_id: str("Connection of from_queue, from list_connections (optional with a single connection)"),
        to_connection_id: str("Connection of to_queue (optional with a single connection)"),
      },
      ["map_id", "from_queue", "to_queue"],
    ),
    annotations: rw(false, true),
    schema: zMap.extend({
      from_queue: z.string().min(1).max(255),
      to_queue: z.string().min(1).max(255),
      label: z.string().max(120).optional(),
      from_connection_id: z.string().min(1).optional(),
      to_connection_id: z.string().min(1).optional(),
    }),
    run: async (a, ctx) => {
      // Only resolve the default when an end actually omits its connection.
      let fallback: Awaited<ReturnType<typeof connectionOrDefault>> | null = null;
      const pick = async (given: string | undefined) => {
        if (given) return { id: given };
        fallback ??= await connectionOrDefault(ctx, undefined);
        return fallback;
      };
      const from = await pick(a.from_connection_id);
      if ("error" in from) return from.error;
      const to = await pick(a.to_connection_id);
      if ("error" in to) return to.error;
      return forward(ctx, {
        method: "POST",
        url: `${mapPath(a)}/edges`,
        body: { from: { connectionId: from.id, queueName: a.from_queue }, to: { connectionId: to.id, queueName: a.to_queue }, label: a.label },
      });
    },
  }),
  tool({
    name: "remove_flow_edge",
    title: "Remove an arrow from a flow map",
    description: "Removes a drawn arrow (source manual) from a manual flow map; its edge id is in get_flow_map. The queues stay on the map. Detected arrows cannot be removed.",
    access: "write",
    inputSchema: object({ map_id: str("Flow map id"), edge_id: str("Edge id, from get_flow_map") }, ["map_id", "edge_id"]),
    annotations: rw(true, true),
    schema: zMap.extend({ edge_id: z.string().min(1) }),
    run: (a, ctx) => forward(ctx, { method: "DELETE", url: `${mapPath(a)}/edges/${seg(a.edge_id)}` }),
  }),
  tool({
    name: "copy_flow_map",
    title: "Copy flow map",
    description:
      "Copies a flow map into a new manual one with the same queues and positions (and drawn arrows). This is how a detected map becomes editable; its detected arrows keep being shown live, they are not copied.",
    access: "write",
    inputSchema: object({ map_id: str("Flow map id to copy (manual or detected)"), name: str("Name of the copy (default: '<name> (copy)')", { maxLength: 80 }), parent_id: str("Manual map to nest the copy under") }, ["map_id"]),
    annotations: rw(false, false),
    schema: zMap.extend({ name: z.string().trim().min(1).max(80).optional(), parent_id: z.string().min(1).optional() }),
    run: (a, ctx) => forward(ctx, { method: "POST", url: `${mapPath(a)}/copy`, body: { name: a.name, parentId: a.parent_id } }),
  }),

  // ----- destructive: a link, never an action -----
  tool({
    name: "request_destructive_action",
    title: "Drain, clean or obliterate (link to the dashboard)",
    description:
      "Bullpane never drains, cleans or obliterates a queue, or drains a BullMQ Pro group, from MCP. This returns a dashboard link that opens the confirmation dialog for that action; give it to the user so they can review and confirm it themselves. drain_group needs group_id.",
    access: "read",
    inputSchema: object(
      { ...QUEUE, action: str("Action", { enum: ["drain", "clean", "obliterate", "drain_group"] }), group_id: str("Group id, for drain_group") },
      ["connection_id", "queue", "action"],
    ),
    annotations: ro,
    schema: zQueue
      .extend({ action: z.enum(["drain", "clean", "obliterate", "drain_group"]), group_id: z.string().min(1).max(200).optional() })
      .refine((a) => a.action !== "drain_group" || !!a.group_id, { message: "drain_group needs group_id", path: ["group_id"] }),
    run: async (a, ctx) => {
      if (a.action === "drain_group") {
        const url = `${ctx.publicUrl}/c/${seg(a.connection_id)}/q/${seg(a.queue)}/groups/${seg(a.group_id ?? "")}?confirm=drain`;
        return textResult({ url, message: "Bullpane does not drain groups from MCP. Open this link to review and confirm it in the dashboard (it requires the admin role)." });
      }
      const url = `${ctx.publicUrl}/c/${seg(a.connection_id)}/q/${seg(a.queue)}?confirm=${a.action}`;
      return textResult({
        url,
        message: `Bullpane does not ${a.action} queues from MCP. Open this link to review and confirm it in the dashboard (it requires the ${a.action === "clean" ? "operator" : "admin"} role).`,
      });
    },
  }),
];

export function toolsFor(access: "off" | "read" | "write"): McpTool[] {
  if (access === "off") return [];
  return access === "write" ? MCP_TOOLS : MCP_TOOLS.filter((t) => t.access === "read");
}
