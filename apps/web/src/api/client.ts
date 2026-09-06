import type { ApiError, ProFeature } from "@bullmq-visualizer/shared";

/**
 * Tiny fetch wrapper. Every call to the server goes through here so the
 * 401 / 402 / 423 behaviours are handled in exactly one place.
 */

export class ApiRequestError extends Error {
  readonly status: number;
  readonly body: ApiError;

  constructor(status: number, body: ApiError) {
    super(body.message || body.error || `Request failed (${status})`);
    this.name = "ApiRequestError";
    this.status = status;
    this.body = body;
  }

  get code(): string {
    return this.body.error;
  }
}

export function isApiError(e: unknown): e is ApiRequestError {
  return e instanceof ApiRequestError;
}

export function errorMessage(e: unknown, fallback = "Something went wrong"): string {
  if (isApiError(e)) {
    if (e.status === 0) return "Could not reach the server";
    return e.body.message || e.body.error || fallback;
  }
  if (e instanceof Error) return e.message || fallback;
  return fallback;
}

export interface ApiHandlers {
  onUnauthenticated: () => void;
  onProRequired: (feature: ProFeature | undefined) => void;
  onDemoLocked: (message: string) => void;
}

const handlers: Partial<ApiHandlers> = {};

/** Registered once by the app shell (AuthProvider). */
export function setApiHandlers(next: Partial<ApiHandlers>) {
  Object.assign(handlers, next);
}

export type QueryParams = Record<string, string | number | boolean | null | undefined>;

export interface RequestOptions {
  query?: QueryParams;
  /** true = never dispatch global handlers; array = skip them for these statuses */
  silent?: boolean | number[];
  signal?: AbortSignal;
}

export const API_BASE = "/api";

export function buildUrl(path: string, query?: QueryParams): string {
  const url = path.startsWith("/") ? `${API_BASE}${path}` : `${API_BASE}/${path}`;
  if (!query) return url;
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === null || v === "") continue;
    sp.set(k, String(v));
  }
  const qs = sp.toString();
  return qs ? `${url}?${qs}` : url;
}

function isApiErrorBody(v: unknown): v is ApiError {
  return (
    typeof v === "object" &&
    v !== null &&
    typeof (v as Record<string, unknown>).error === "string"
  );
}

async function request<T>(
  method: string,
  path: string,
  body?: unknown,
  opts: RequestOptions = {},
): Promise<T> {
  const headers: Record<string, string> = { accept: "application/json" };
  if (body !== undefined) headers["content-type"] = "application/json";

  let res: Response;
  try {
    res = await fetch(buildUrl(path, opts.query), {
      method,
      credentials: "same-origin",
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: opts.signal,
    });
  } catch (e) {
    if (e instanceof DOMException && e.name === "AbortError") throw e;
    throw new ApiRequestError(0, { error: "network", message: "Could not reach the server" });
  }

  const text = await res.text();
  let data: unknown = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }

  if (res.ok) return data as T;

  const errBody: ApiError = isApiErrorBody(data)
    ? data
    : {
        error: `http_${res.status}`,
        message:
          (typeof data === "string" && data.slice(0, 200)) ||
          res.statusText ||
          `Request failed (${res.status})`,
      };
  const err = new ApiRequestError(res.status, errBody);

  const silent =
    opts.silent === true || (Array.isArray(opts.silent) && opts.silent.includes(res.status));
  if (!silent) dispatch(err);
  throw err;
}

function dispatch(err: ApiRequestError) {
  switch (err.status) {
    case 401:
      handlers.onUnauthenticated?.();
      break;
    case 402:
      handlers.onProRequired?.(err.body.feature);
      break;
    case 423:
      handlers.onDemoLocked?.(err.body.message);
      break;
    default:
      break;
  }
}

export const api = {
  get: <T>(path: string, opts?: RequestOptions) => request<T>("GET", path, undefined, opts),
  post: <T>(path: string, body?: unknown, opts?: RequestOptions) =>
    request<T>("POST", path, body ?? {}, opts),
  patch: <T>(path: string, body?: unknown, opts?: RequestOptions) =>
    request<T>("PATCH", path, body ?? {}, opts),
  put: <T>(path: string, body?: unknown, opts?: RequestOptions) =>
    request<T>("PUT", path, body ?? {}, opts),
  del: <T>(path: string, opts?: RequestOptions) => request<T>("DELETE", path, undefined, opts),
};

/** Encode a path segment (queue names, job ids may contain anything). */
export const seg = (s: string) => encodeURIComponent(s);
