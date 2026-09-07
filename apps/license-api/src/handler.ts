/**
 * Request handling, kept free of Worker globals so it runs under vitest with a
 * scripted fetch.
 *
 *   POST /v1/license/activate    { key, instance }        → { lease }
 *   POST /v1/license/refresh     { key, activationId }    → { lease }
 *   POST /v1/license/deactivate  { key, activationId }    → 204
 *   GET  /v1/health                                       → { ok: true }
 *
 * A lease is a LicensePayload signed with the vendor key; the dashboard
 * verifies it exactly like an offline token. `expiresAt` is now + LEASE_DAYS,
 * so a dashboard that cannot reach us keeps Pro for that long.
 */
import {
  type LicenseApiError,
  type LicenseLeaseResponse,
  type LicensePayload,
  licenseActivateRequestSchema,
  licenseRefreshRequestSchema,
} from "@bullpane/shared";
import { ZodError } from "zod";
import { ApiFail, type PolarLicenseKey, PolarClient, statusFor } from "./polar";
import { signLease } from "./sign";

export interface Deps {
  fetchImpl: typeof fetch;
  now: () => number;
  privateKey: CryptoKey;
  polarBase: string;
  organizationId: string;
  leaseDays: number;
}

const DAY = 86_400_000;
const MAX_BODY_BYTES = 4096;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

function fail(status: number, error: LicenseApiError["error"], message: string): Response {
  return json(status, { error, message } satisfies LicenseApiError);
}

async function readJson(request: Request): Promise<unknown> {
  const length = Number(request.headers.get("content-length") ?? "0");
  if (length > MAX_BODY_BYTES) throw new ApiFail("validation", "Body too large", 413);
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) throw new ApiFail("validation", "Body too large", 413);
  try {
    return JSON.parse(text);
  } catch {
    throw new ApiFail("validation", "Body must be JSON", 400);
  }
}

function customerOf(lk: PolarLicenseKey): { licensee: string; email: string } {
  const c = lk.customer ?? lk.user ?? null;
  const email = (c?.email ?? "").trim() || "unknown";
  const licensee = (c?.name ?? "").trim() || email;
  return { licensee, email };
}

function leasePayload(lk: PolarLicenseKey, activationId: string, deps: Deps): LicensePayload {
  const now = deps.now();
  const { licensee, email } = customerOf(lk);
  return {
    licensee,
    email,
    plan: "pro",
    issuedAt: now,
    expiresAt: now + deps.leaseDays * DAY,
    subscriptionExpiresAt: lk.expires_at ? Date.parse(lk.expires_at) : null,
    activationId,
    billing: "subscription",
  };
}

export async function handle(request: Request, deps: Deps): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "");

  if (request.method === "GET" && path === "/v1/health") return json(200, { ok: true });
  if (request.method !== "POST") return fail(405, "validation", "Method not allowed");

  const polar = new PolarClient({ base: deps.polarBase, organizationId: deps.organizationId, fetchImpl: deps.fetchImpl });

  try {
    switch (path) {
      case "/v1/license/activate": {
        const body = licenseActivateRequestSchema.parse(await readJson(request));
        const activation = await polar.activate(body.key, body.instance.label, body.instance.version ? { version: body.instance.version } : {});
        const lease = await signLease(leasePayload(activation.license_key, activation.id, deps), deps.privateKey);
        return json(200, { lease } satisfies LicenseLeaseResponse);
      }
      case "/v1/license/refresh": {
        const body = licenseRefreshRequestSchema.parse(await readJson(request));
        const validation = await polar.validate(body.key, body.activationId);
        const lease = await signLease(leasePayload(validation, body.activationId, deps), deps.privateKey);
        return json(200, { lease } satisfies LicenseLeaseResponse);
      }
      case "/v1/license/deactivate": {
        const body = licenseRefreshRequestSchema.parse(await readJson(request));
        try {
          await polar.deactivate(body.key, body.activationId);
        } catch (err) {
          // Already gone is the outcome the caller wanted.
          if (!(err instanceof ApiFail) || !["license_not_found", "license_activation_mismatch"].includes(err.code)) throw err;
        }
        return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
      }
      default:
        return fail(404, "validation", "Not found");
    }
  } catch (err) {
    if (err instanceof ZodError) {
      return fail(400, "validation", err.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; "));
    }
    if (err instanceof ApiFail) return fail(err.status || statusFor(err.code), err.code, err.message);
    console.error("license-api unexpected error", err);
    return fail(500, "upstream_unavailable", "Unexpected error");
  }
}
