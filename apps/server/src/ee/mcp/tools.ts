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
 */
import { JOB_STATES } from "@bullpane/shared";
import { z } from "zod";

export interface ApiCall {
  method: "GET" | "POST" | "DELETE";
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
      "Searches the jobs of one state for a text in the job id, name, data or failure reason. Scans in pages: pass next_cursor back as cursor to continue.",
    access: "read",
    inputSchema: object(
      {
        ...QUEUE,
        query: str("Text to look for"),
        state: str("Job state to search", { enum: [...JOB_STATES], default: "failed" }),
        cursor: str("Cursor from a previous call's nextCursor"),
        limit: int("Max matches", 1, 200),
      },
      ["connection_id", "queue", "query"],
    ),
    annotations: ro,
    schema: zQueue.extend({ query: z.string().min(1).max(500), state: zState.optional(), cursor: z.string().optional(), limit: z.number().int().min(1).max(200).optional() }),
    run: (a, ctx) =>
      forward(ctx, { method: "GET", url: `${queuePath(a)}/jobs/search${qs({ q: a.query, state: a.state, cursor: a.cursor, limit: a.limit })}` }),
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
    description: "BullMQ Pro groups of a queue: status (rate limited, paused, maxed), waiting and active per group. Empty on plain BullMQ.",
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

  // ----- destructive: a link, never an action -----
  tool({
    name: "request_destructive_action",
    title: "Drain, clean or obliterate (link to the dashboard)",
    description:
      "Bullpane never drains, cleans or obliterates a queue from MCP. This returns a dashboard link that opens the confirmation dialog for that action; give it to the user so they can review and confirm it themselves.",
    access: "read",
    inputSchema: object({ ...QUEUE, action: str("Action", { enum: ["drain", "clean", "obliterate"] }) }, ["connection_id", "queue", "action"]),
    annotations: ro,
    schema: zQueue.extend({ action: z.enum(["drain", "clean", "obliterate"]) }),
    run: async (a, ctx) => {
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
