import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  conflict,
  demoLocked,
  forbidden,
  HttpError,
  invalidLicense,
  mapError,
  notFound,
  proRequired,
  redisUnavailable,
  unauthenticated,
  validation,
} from "../plugins/errors";
import { isRedisConnectionError, mapInspectorError } from "../services/inspector-errors";

describe("mapError", () => {
  it("maps the helpers to the API.md status codes and bodies", () => {
    expect(mapError(validation("bad", { x: 1 }))).toEqual({
      status: 400,
      body: { error: "validation", message: "bad", details: { x: 1 } },
      unexpected: false,
    });
    expect(mapError(unauthenticated()).status).toBe(401);
    expect(mapError(unauthenticated()).body.error).toBe("unauthenticated");
    expect(mapError(forbidden()).status).toBe(403);
    expect(mapError(forbidden()).body.error).toBe("forbidden");
    expect(mapError(proRequired("folders"))).toEqual({
      status: 402,
      body: { error: "pro_required", message: expect.any(String), feature: "folders" },
      unexpected: false,
    });
    expect(mapError(notFound("Alert"))).toMatchObject({ status: 404, body: { error: "not_found", message: "Alert not found" } });
    expect(mapError(conflict("dup"))).toMatchObject({ status: 409, body: { error: "conflict", message: "dup" } });
    expect(mapError(demoLocked())).toMatchObject({ status: 423, body: { error: "demo_locked" } });
    expect(mapError(invalidLicense("expired"))).toMatchObject({ status: 400, body: { error: "invalid_license" } });
    expect(mapError(redisUnavailable(new Error("ECONNREFUSED")))).toMatchObject({
      status: 502,
      body: { error: "redis_unavailable", message: expect.stringContaining("ECONNREFUSED") },
    });
  });

  it("does not leak undefined feature/details keys", () => {
    expect(Object.keys(mapError(notFound()).body)).toEqual(["error", "message"]);
  });

  it("maps zod errors to 400 validation with details", () => {
    const schema = z.object({ email: z.string().email(), n: z.number() });
    const result = schema.safeParse({ email: "nope", n: "x" });
    expect(result.success).toBe(false);
    if (result.success) return;
    const mapped = mapError(result.error);
    expect(mapped.status).toBe(400);
    expect(mapped.body.error).toBe("validation");
    expect(mapped.body.message).toContain("email");
    expect(mapped.body.details).toBeDefined();
  });

  it("maps fastify client errors (e.g. malformed JSON) to 4xx", () => {
    const err = Object.assign(new Error("Unexpected token"), { code: "FST_ERR_CTP_INVALID_JSON_BODY", statusCode: 400 });
    expect(mapError(err)).toMatchObject({ status: 400, body: { error: "validation" }, unexpected: false });
  });

  it("hides unknown errors behind a 500", () => {
    const mapped = mapError(new Error("secret database detail"));
    expect(mapped.status).toBe(500);
    expect(mapped.body).toEqual({ error: "internal", message: "Internal server error" });
    expect(mapped.unexpected).toBe(true);
  });

  it("custom HttpError round-trips", () => {
    const e = new HttpError(418, "teapot", "short and stout", { details: [1, 2] });
    expect(mapError(e)).toEqual({ status: 418, body: { error: "teapot", message: "short and stout", details: [1, 2] }, unexpected: false });
  });
});

describe("inspector error mapping", () => {
  it("recognises connection failures", () => {
    expect(isRedisConnectionError(new Error("connect ECONNREFUSED 127.0.0.1:6379"))).toBe(true);
    expect(isRedisConnectionError(Object.assign(new Error("x"), { code: "ETIMEDOUT" }))).toBe(true);
    expect(isRedisConnectionError(Object.assign(new Error("Reached the max retries per request limit"), { name: "MaxRetriesPerRequestError" }))).toBe(true);
    expect(isRedisConnectionError(new Error("Connection is closed."))).toBe(true);
    expect(isRedisConnectionError(new Error("Stream isn't writeable and enableOfflineQueue options is false"))).toBe(true);
    expect(isRedisConnectionError(new Error("Job is not in the failed state"))).toBe(false);
  });

  it("maps to 502 / 404 / 409", () => {
    expect(mapInspectorError(new Error("connect ECONNREFUSED")).status).toBe(502);
    expect(mapInspectorError(new Error("Missing key for job 42. finished")).status).toBe(404);
    expect(mapInspectorError(new Error("Job 42 is not in the failed state. retryJob"))).toMatchObject({ status: 409, error: "conflict" });
    const passthrough = notFound("Queue");
    expect(mapInspectorError(passthrough)).toBe(passthrough);
  });
});
