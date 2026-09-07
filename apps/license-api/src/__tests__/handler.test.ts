/**
 * The worker against a scripted Polar. Leases are verified with node:crypto the
 * same way the dashboard does, so a format drift between the two shows up here.
 */
import { generateKeyPairSync, verify as cryptoVerify } from "node:crypto";
import type { LicensePayload } from "@bullmq-visualizer/shared";
import { beforeAll, describe, expect, it } from "vitest";
import { type Deps, handle } from "../handler";
import { importPrivateKey } from "../sign";

const NOW = Date.UTC(2026, 8, 7, 12);
const DAY = 86_400_000;
const ORG = "org_test";

const pair = generateKeyPairSync("ed25519");
const privatePem = pair.privateKey.export({ type: "pkcs8", format: "pem" }) as string;
const publicKey = pair.publicKey;

let privateKey: CryptoKey;
beforeAll(async () => {
  privateKey = await importPrivateKey(privatePem);
});

function decodeLease(lease: string): LicensePayload {
  const [payloadB64, sigB64] = lease.split(".") as [string, string];
  const ok = cryptoVerify(null, Buffer.from(payloadB64), publicKey, Buffer.from(sigB64, "base64url"));
  expect(ok).toBe(true);
  return JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8")) as LicensePayload;
}

type Route = (body: Record<string, unknown>) => Response | Promise<Response>;

function polar(routes: Record<string, Route>, seen: Array<{ path: string; body: Record<string, unknown> }> = []): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    seen.push({ path: url.pathname, body });
    const route = routes[url.pathname];
    if (!route) return new Response(JSON.stringify({ detail: "no route" }), { status: 500 });
    return route(body);
  }) as typeof fetch;
}

const jsonRes = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const LICENSE_KEY = {
  id: "lk_1",
  status: "granted",
  expires_at: "2026-10-07T12:00:00Z",
  limit_activations: 1,
  usage: 0,
  customer: { email: "ops@acme.test", name: "Acme Inc" },
};

function deps(fetchImpl: typeof fetch, extra: Partial<Deps> = {}): Deps {
  return { fetchImpl, now: () => NOW, privateKey, polarBase: "https://polar.test", organizationId: ORG, leaseDays: 7, ...extra };
}

function post(path: string, body: unknown): Request {
  return new Request(`https://api.bullpane.com${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}

describe("license API", () => {
  it("activates a key at Polar and answers with a signed 7-day lease", async () => {
    const seen: Array<{ path: string; body: Record<string, unknown> }> = [];
    const fetchImpl = polar(
      {
        "/v1/customer-portal/license-keys/activate": () =>
          jsonRes(200, { id: "act_1", license_key_id: "lk_1", label: "prod-01", created_at: "x", license_key: LICENSE_KEY }),
      },
      seen,
    );
    const res = await handle(post("/v1/license/activate", { key: "BULLPANE-ABCD-1234", instance: { label: "prod-01 · queues.acme.io", version: "0.1.0" } }), deps(fetchImpl));
    expect(res.status).toBe(200);
    const { lease } = (await res.json()) as { lease: string };
    const payload = decodeLease(lease);
    expect(payload).toEqual({
      licensee: "Acme Inc",
      email: "ops@acme.test",
      plan: "pro",
      issuedAt: NOW,
      expiresAt: NOW + 7 * DAY,
      subscriptionExpiresAt: Date.parse("2026-10-07T12:00:00Z"),
      activationId: "act_1",
      billing: "subscription",
    });
    expect(seen[0]).toEqual({
      path: "/v1/customer-portal/license-keys/activate",
      body: { key: "BULLPANE-ABCD-1234", organization_id: ORG, label: "prod-01 · queues.acme.io", meta: { version: "0.1.0" } },
    });
  });

  it("maps Polar's activation-limit refusal to 409 license_activation_limit", async () => {
    const fetchImpl = polar({
      "/v1/customer-portal/license-keys/activate": () => jsonRes(403, { error: "NotPermitted", detail: "License key activation limit already reached" }),
    });
    const res = await handle(post("/v1/license/activate", { key: "BULLPANE-ABCD-1234", instance: { label: "x" } }), deps(fetchImpl));
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe("license_activation_limit");
    expect(body.message).toMatch(/another installation/);
  });

  it("maps unknown keys to 404, expired to 403 license_expired, and Polar outages to 502", async () => {
    const cases: Array<[Response, number, string]> = [
      [jsonRes(404, { error: "ResourceNotFound", detail: "License key not found" }), 404, "license_not_found"],
      [jsonRes(403, { detail: "License key has expired" }), 403, "license_expired"],
      [jsonRes(403, { detail: "License key is revoked" }), 403, "license_revoked"],
      [jsonRes(403, { detail: "Activation does not belong to this key" }), 403, "license_activation_mismatch"],
      [new Response("bad gateway", { status: 502 }), 502, "upstream_unavailable"],
    ];
    for (const [polarResponse, status, code] of cases) {
      const fetchImpl = polar({ "/v1/customer-portal/license-keys/validate": () => polarResponse.clone() });
      const res = await handle(post("/v1/license/refresh", { key: "BULLPANE-ABCD-1234", activationId: "act_1" }), deps(fetchImpl));
      expect(res.status).toBe(status);
      expect(((await res.json()) as { error: string }).error).toBe(code);
    }
  });

  it("refreshes with the activation id and re-issues a lease from the validation", async () => {
    const seen: Array<{ path: string; body: Record<string, unknown> }> = [];
    const fetchImpl = polar(
      { "/v1/customer-portal/license-keys/validate": () => jsonRes(200, { ...LICENSE_KEY, expires_at: null, activation: { id: "act_1", label: "x" } }) },
      seen,
    );
    const res = await handle(post("/v1/license/refresh", { key: "BULLPANE-ABCD-1234", activationId: "act_1" }), deps(fetchImpl, { now: () => NOW + DAY }));
    expect(res.status).toBe(200);
    const payload = decodeLease(((await res.json()) as { lease: string }).lease);
    expect(payload.activationId).toBe("act_1");
    expect(payload.issuedAt).toBe(NOW + DAY);
    expect(payload.expiresAt).toBe(NOW + 8 * DAY);
    expect(payload.subscriptionExpiresAt).toBeNull();
    expect(seen[0]?.body).toEqual({ key: "BULLPANE-ABCD-1234", organization_id: ORG, activation_id: "act_1" });
  });

  it("refuses a 200 whose status is not granted or whose activation differs", async () => {
    const revoked = polar({ "/v1/customer-portal/license-keys/validate": () => jsonRes(200, { ...LICENSE_KEY, status: "revoked" }) });
    let res = await handle(post("/v1/license/refresh", { key: "BULLPANE-ABCD-1234", activationId: "act_1" }), deps(revoked));
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe("license_revoked");

    const other = polar({ "/v1/customer-portal/license-keys/validate": () => jsonRes(200, { ...LICENSE_KEY, activation: { id: "act_9", label: "y" } }) });
    res = await handle(post("/v1/license/refresh", { key: "BULLPANE-ABCD-1234", activationId: "act_1" }), deps(other));
    expect(((await res.json()) as { error: string }).error).toBe("license_activation_mismatch");
  });

  it("deactivates, and treats 'already gone' as success", async () => {
    const ok = polar({ "/v1/customer-portal/license-keys/deactivate": () => new Response(null, { status: 204 }) });
    expect((await handle(post("/v1/license/deactivate", { key: "BULLPANE-ABCD-1234", activationId: "act_1" }), deps(ok))).status).toBe(204);
    const gone = polar({ "/v1/customer-portal/license-keys/deactivate": () => jsonRes(404, { detail: "Activation not found" }) });
    expect((await handle(post("/v1/license/deactivate", { key: "BULLPANE-ABCD-1234", activationId: "act_1" }), deps(gone))).status).toBe(204);
  });

  it("validates input and never forwards junk to Polar", async () => {
    const seen: Array<{ path: string; body: Record<string, unknown> }> = [];
    const fetchImpl = polar({}, seen);
    const bad = await handle(post("/v1/license/activate", { key: "short", instance: {} }), deps(fetchImpl));
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: string }).error).toBe("validation");
    const notJson = await handle(new Request("https://api.bullpane.com/v1/license/refresh", { method: "POST", body: "{" }), deps(fetchImpl));
    expect(notJson.status).toBe(400);
    const wrongMethod = await handle(new Request("https://api.bullpane.com/v1/license/refresh"), deps(fetchImpl));
    expect(wrongMethod.status).toBe(405);
    expect(seen).toEqual([]);
  });

  it("answers health without touching Polar", async () => {
    const res = await handle(new Request("https://api.bullpane.com/v1/health"), deps(polar({})));
    expect(await res.json()).toEqual({ ok: true });
  });
});
