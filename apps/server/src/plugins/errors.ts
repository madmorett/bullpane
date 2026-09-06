/**
 * Central error mapping → ApiError (docs/API.md).
 * Throw HttpError (or the helpers) anywhere; the handler serialises it.
 */
import type { ApiError, ProFeature } from "@bullmq-visualizer/shared";
import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { ZodError } from "zod";

export class HttpError extends Error {
  readonly status: number;
  readonly error: string;
  readonly extra: Partial<Pick<ApiError, "feature" | "details">>;

  constructor(status: number, error: string, message: string, extra: Partial<Pick<ApiError, "feature" | "details">> = {}) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.error = error;
    this.extra = extra;
  }

  toBody(): ApiError {
    const body: ApiError = { error: this.error, message: this.message };
    if (this.extra.feature !== undefined) body.feature = this.extra.feature;
    if (this.extra.details !== undefined) body.details = this.extra.details;
    return body;
  }
}

export const validation = (message: string, details?: unknown) => new HttpError(400, "validation", message, { details });
export const unauthenticated = (message = "Login required") => new HttpError(401, "unauthenticated", message);
export const forbidden = (message = "Your role does not allow this action") => new HttpError(403, "forbidden", message);
export const proRequired = (feature: ProFeature) =>
  new HttpError(402, "pro_required", `"${feature}" is a Pro feature. Unlock Pro to use it.`, { feature });
export const notFound = (what = "Resource") => new HttpError(404, "not_found", `${what} not found`);
export const conflict = (message: string) => new HttpError(409, "conflict", message);
export const demoLocked = (message = "This action is disabled in the public demo") =>
  new HttpError(423, "demo_locked", message);

/** BMV_READ_ONLY=true: the whole instance refuses writes. */
export const readOnlyLocked = (): HttpError =>
  new HttpError(423, "read_only", "This instance runs in read-only mode (BMV_READ_ONLY=true). Writes are disabled.");
export const invalidLicense = (reason: string) => new HttpError(400, "invalid_license", `Invalid license: ${reason}`);
export const redisUnavailable = (err: unknown) =>
  new HttpError(502, "redis_unavailable", `Redis connection failed: ${errorMessage(err)}`);

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return typeof err === "string" ? err : JSON.stringify(err);
}

export interface MappedError {
  status: number;
  body: ApiError;
  /** true when the error is unexpected and should be logged at error level */
  unexpected: boolean;
}

function isFastifyError(err: unknown): err is FastifyError {
  return typeof err === "object" && err !== null && "code" in err && typeof (err as FastifyError).code === "string";
}

/** Pure mapping so it can be unit tested without a server. */
export function mapError(err: unknown): MappedError {
  if (err instanceof HttpError) {
    return { status: err.status, body: err.toBody(), unexpected: false };
  }
  if (err instanceof ZodError) {
    return {
      status: 400,
      body: {
        error: "validation",
        message: err.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; "),
        details: err.flatten(),
      },
      unexpected: false,
    };
  }
  if (isFastifyError(err)) {
    const status = err.statusCode ?? 500;
    if (status >= 400 && status < 500) {
      const error = status === 400 ? "validation" : status === 404 ? "not_found" : status === 415 ? "unsupported_media_type" : "bad_request";
      return { status, body: { error, message: err.message }, unexpected: false };
    }
  }
  return {
    status: 500,
    body: { error: "internal", message: "Internal server error" },
    unexpected: true,
  };
}

export function registerErrorHandling(app: FastifyInstance): void {
  app.setErrorHandler((err: unknown, request: FastifyRequest, reply: FastifyReply) => {
    const mapped = mapError(err);
    if (mapped.unexpected) {
      request.log.error({ err }, "unhandled error");
    } else if (mapped.status >= 500) {
      request.log.warn({ err: errorMessage(err), url: request.url }, mapped.body.error);
    }
    void reply.status(mapped.status).send(mapped.body);
  });
}
