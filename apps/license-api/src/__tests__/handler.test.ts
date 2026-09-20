/**
 * The worker against a scripted Creem. Leases are verified with node:crypto the
 * same way the dashboard does, so a format drift between the two shows up here.
 */
import { generateKeyPairSync, verify as cryptoVerify } from "node:crypto";
import type { LicensePayload } from "@bullpane/shared";
import { beforeAll, describe, expect, it } from "vitest";
import { CreemClient } from "../creem";
import { type Deps, handle } from "../handler";
import { importPrivateKey } from "../sign";

const NOW = Date.UTC(2026, 8, 7, 12);
const DAY = 86_400_000;
const API_KEY = "creem_test_key";

const pair = generateKeyPairSync("ed25519");
const privatePem = pair.privateKey.export({ type: "pkcs8", format: "pem" }) as string;
const publicKey = pair.publicKey;

let privateKey: CryptoKey;
beforeAll(async () => {
  privateKey = await importPrivateKey(privatePem);
});

function decodeLease(lease: string): LicensePayload {
  const [payloadB64, sigB64] = lease.split(".") as [string, string];
  expect(cryptoVerify(null, Buffer.from(payloadB64), publicKey, Buffer.from(sigB64, "base64url"))).toBe(true);
  return JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8")) as LicensePayload;
}

type Route = (body: Record<string, unknown>, headers: Headers) => Response | Promise<Response>;
type Seen = Array<{ path: string; body: Record<string, unknown>; apiKey: string | null }>;

function creem(routes: Record<string, Route>, seen: Seen = []): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const headers = new Headers(init?.headers);
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    seen.push({ path: url.pathname, body, apiKey: headers.get("x-api-key") });
    const route = routes[url.pathname];
    if (!route) return new Response(JSON.stringify({ message: "no route" }), { status: 500 });
    return route(body, headers);
  }) as typeof fetch;
}

const jsonRes = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const LICENSE = {
  id: "lic_1",
  mode: "prod",
  object: "license",
  product_id: "prod_1",
  status: "active",
  key: "BULLPANE-ABCD-1234-EFGH",
  activation: 1,
  activation_limit: 1,
  expires_at: "2026-10-07T12:00:00Z",
  created_at: "2026-09-07T12:00:00Z",
  instance: { id: "inst_1", mode: "prod", object: "license-instance", name: "prod-01", status: "active", created_at: "x" },
};

function deps(fetchImpl: typeof fetch, extra: Partial<Deps> = {}): Deps {
  return {
    store: new CreemClient({ base: "https://creem.test", apiKey: API_KEY, fetchImpl }),
    now: () => NOW,
    privateKey,
    leaseDays: 7,
    ...extra,
  };
}

function post(path: string, body: unknown): Request {
  return new Request(`https://api.bullpane.com${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}

const KEY = "BULLPANE-ABCD-1234-EFGH";

describe("license API (Creem)", () => {
  it("activates at Creem with the store key and answers with a signed 7-day lease", async () => {
    const seen: Seen = [];
    const res = await handle(
      post("/v1/license/activate", { key: KEY, instance: { label: "prod-01 · queues.acme.io", version: "0.1.0" } }),
      deps(creem({ "/v1/licenses/activate": () => jsonRes(200, LICENSE) }, seen)),
    );
    expect(res.status).toBe(200);
    const payload = decodeLease(((await res.json()) as { lease: string }).lease);
    expect(payload).toEqual({
      licensee: "Bullpane Pro · key ····EFGH",
      email: "see your bullpane.com receipt",
      plan: "pro",
      issuedAt: NOW,
      expiresAt: NOW + 7 * DAY,
      subscriptionExpiresAt: Date.parse("2026-10-07T12:00:00Z"),
      activationId: "inst_1",
      billing: "subscription",
    });
    expect(seen[0]).toEqual({ path: "/v1/licenses/activate", body: { key: KEY, instance_name: "prod-01 · queues.acme.io" }, apiKey: API_KEY });
  });

  it("maps an activation-limit refusal to 409 license_activation_limit", async () => {
    const res = await handle(
      post("/v1/license/activate", { key: KEY, instance: { label: "x" } }),
      deps(creem({ "/v1/licenses/activate": () => jsonRes(400, { message: ["License key has reached its activation limit"] }) })),
    );
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe("license_activation_limit");
    expect(body.message).toMatch(/another installation/);
  });

  it("maps unknown keys to 404, expired to 403, our own bad API key and outages to 502", async () => {
    const cases: Array<[Response, number, string]> = [
      [jsonRes(404, { message: "License key not found" }), 404, "license_not_found"],
      [jsonRes(400, { message: "License key has expired" }), 403, "license_expired"],
      [jsonRes(401, { message: "Invalid API Key" }), 502, "upstream_unavailable"],
      [new Response("bad gateway", { status: 502 }), 502, "upstream_unavailable"],
    ];
    for (const [creemResponse, status, code] of cases) {
      const res = await handle(
        post("/v1/license/refresh", { key: KEY, activationId: "inst_1" }),
        deps(creem({ "/v1/licenses/validate": () => creemResponse.clone() })),
      );
      expect(res.status).toBe(status);
      expect(((await res.json()) as { error: string }).error).toBe(code);
    }
  });

  it("refreshes with the instance id and re-issues a lease", async () => {
    const seen: Seen = [];
    const res = await handle(
      post("/v1/license/refresh", { key: KEY, activationId: "inst_1" }),
      deps(creem({ "/v1/licenses/validate": () => jsonRes(200, { ...LICENSE, expires_at: null }) }, seen), { now: () => NOW + DAY }),
    );
    expect(res.status).toBe(200);
    const payload = decodeLease(((await res.json()) as { lease: string }).lease);
    expect(payload.activationId).toBe("inst_1");
    expect(payload.issuedAt).toBe(NOW + DAY);
    expect(payload.expiresAt).toBe(NOW + 8 * DAY);
    expect(payload.subscriptionExpiresAt).toBeNull();
    expect(seen[0]?.body).toEqual({ key: KEY, instance_id: "inst_1" });
  });

  it("treats a 200 with a non-active status, or a deactivated / different instance, as a refusal", async () => {
    const cases: Array<[unknown, string]> = [
      [{ ...LICENSE, status: "disabled" }, "license_revoked"],
      [{ ...LICENSE, status: "inactive" }, "license_revoked"],
      [{ ...LICENSE, status: "expired" }, "license_expired"],
      [{ ...LICENSE, instance: { ...LICENSE.instance, status: "deactivated" } }, "license_activation_mismatch"],
      [{ ...LICENSE, instance: { ...LICENSE.instance, id: "inst_9" } }, "license_activation_mismatch"],
    ];
    for (const [body, code] of cases) {
      const res = await handle(post("/v1/license/refresh", { key: KEY, activationId: "inst_1" }), deps(creem({ "/v1/licenses/validate": () => jsonRes(200, body) })));
      expect(res.status).toBe(403);
      expect(((await res.json()) as { error: string }).error).toBe(code);
    }
  });

  it("deactivates, and treats 'already gone' as success", async () => {
    const ok = creem({ "/v1/licenses/deactivate": () => jsonRes(200, { ...LICENSE, instance: { ...LICENSE.instance, status: "deactivated" } }) });
    expect((await handle(post("/v1/license/deactivate", { key: KEY, activationId: "inst_1" }), deps(ok))).status).toBe(204);
    const gone = creem({ "/v1/licenses/deactivate": () => jsonRes(404, { message: "Instance not found" }) });
    expect((await handle(post("/v1/license/deactivate", { key: KEY, activationId: "inst_1" }), deps(gone))).status).toBe(204);
  });

  it("validates input and never forwards junk to the store", async () => {
    const seen: Seen = [];
    const fetchImpl = creem({}, seen);
    const bad = await handle(post("/v1/license/activate", { key: "short", instance: {} }), deps(fetchImpl));
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: string }).error).toBe("validation");
    const notJson = await handle(new Request("https://api.bullpane.com/v1/license/refresh", { method: "POST", body: "{" }), deps(fetchImpl));
    expect(notJson.status).toBe(400);
    const wrongMethod = await handle(new Request("https://api.bullpane.com/v1/license/refresh"), deps(fetchImpl));
    expect(wrongMethod.status).toBe(405);
    expect(seen).toEqual([]);
  });

  it("answers health without touching the store", async () => {
    const res = await handle(new Request("https://api.bullpane.com/v1/health"), deps(creem({})));
    expect(await res.json()).toEqual({ ok: true });
  });
});
