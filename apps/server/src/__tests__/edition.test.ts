/**
 * Subscription key lifecycle: activate → lease → daily refresh → grace →
 * definitive rejection → release. Runs against an in-memory settings store and
 * a scripted license client, with a controllable clock.
 */
import { generateKeyPairSync } from "node:crypto";
import type { LicensePayload } from "@bullpane/shared";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../config";
import { signLicense } from "../license";
import { HttpError } from "../plugins/errors";
import { EditionService, LICENSE_ONLINE_SETTING_KEY, LICENSE_SETTING_KEY } from "../services/edition";
import { LicenseApiFailure, type LicenseClient } from "../services/license-client";
import { MemorySettingsStore } from "../services/settings-store";

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 8, 1);
const KEY = "BULLPANE-AAAA-BBBB-CCCC";

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const publicKeyB64 = publicKey.export({ type: "spki", format: "der" }).toString("base64");

function lease(now: number, activationId: string, extra: Partial<LicensePayload> = {}): string {
  return signLicense(
    {
      licensee: "Acme",
      email: "ops@acme.test",
      plan: "pro",
      issuedAt: now,
      expiresAt: now + 7 * DAY,
      subscriptionExpiresAt: now + 30 * DAY,
      activationId,
      billing: "subscription",
      ...extra,
    },
    privateKey,
  );
}

type Script = Partial<{ [K in keyof LicenseClient]: LicenseClient[K] }>;

function scriptedClient(script: Script, calls: string[]): LicenseClient {
  const missing = (name: string) => async () => {
    calls.push(name);
    throw new Error(`unexpected ${name}`);
  };
  return {
    activate: async (req) => {
      calls.push("activate");
      return (script.activate ?? missing("activate"))(req);
    },
    refresh: async (req) => {
      calls.push("refresh");
      return (script.refresh ?? missing("refresh"))(req);
    },
    deactivate: async (req) => {
      calls.push("deactivate");
      return (script.deactivate ?? missing("deactivate"))(req);
    },
  };
}

function harness(script: Script, opts: { env?: Record<string, string>; store?: MemorySettingsStore } = {}) {
  const calls: string[] = [];
  const clock = { now: T0 };
  const store = opts.store ?? new MemorySettingsStore();
  const logs: string[] = [];
  const config = loadConfig(
    { SESSION_SECRET: "x".repeat(40), LICENSE_PUBLIC_KEY_B64: publicKeyB64, ...opts.env },
    { warn: () => undefined },
  );
  const service = new EditionService({
    config,
    settings: store,
    log: { info: (_o, m) => logs.push(m), warn: (_o, m) => logs.push(m) },
    client: scriptedClient(script, calls),
    instanceLabel: "test-host",
    now: () => clock.now,
  });
  return { service, calls, clock, store, logs };
}

describe("EditionService with a subscription key", () => {
  it("activates through the license API, verifies the lease and persists both", async () => {
    const { service, calls, store } = harness({
      activate: async (req) => {
        expect(req).toEqual({ key: KEY, instance: { label: "test-host", version: undefined } });
        return lease(T0, "act_1");
      },
    });
    await service.load();
    expect(service.getEdition().tier).toBe("free");

    const edition = await service.setLicenseKey(`  ${KEY}\n`);
    expect(calls).toEqual(["activate"]);
    expect(edition.tier).toBe("pro");
    expect(edition.license).toMatchObject({ source: "online", status: "active", activationId: "act_1", leaseExpiresAt: T0 + 7 * DAY });
    expect(store.map.get(LICENSE_SETTING_KEY)).toBe(KEY);
    expect(JSON.parse(store.map.get(LICENSE_ONLINE_SETTING_KEY)!)).toMatchObject({ activationId: "act_1", lastCheckedAt: T0, lastCheckError: null });
  });

  it("maps 'already active elsewhere' to 409 and leaves the install untouched", async () => {
    const { service, store } = harness({
      activate: async () => {
        throw new LicenseApiFailure("license_activation_limit", "This key is already active on prod-01", 409);
      },
    });
    await service.load();
    const err = await service.setLicenseKey(KEY).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(409);
    expect((err as HttpError).error).toBe("license_already_activated");
    expect(store.map.size).toBe(0);
    expect(service.getEdition().tier).toBe("free");
  });

  it("maps unknown / revoked keys to 400 and an unreachable API to 502", async () => {
    const notFound = harness({
      activate: async () => {
        throw new LicenseApiFailure("license_not_found", "no such key", 404);
      },
    });
    await notFound.service.load();
    await expect(notFound.service.setLicenseKey(KEY)).rejects.toMatchObject({ status: 400, error: "invalid_license" });

    const down = harness({
      activate: async () => {
        throw new LicenseApiFailure("network", "ECONNREFUSED");
      },
    });
    await down.service.load();
    await expect(down.service.setLicenseKey(KEY)).rejects.toMatchObject({ status: 502, error: "license_server_unavailable" });
  });

  it("rejects a lease this build cannot verify instead of trusting the network", async () => {
    const other = generateKeyPairSync("ed25519").privateKey;
    const { service } = harness({
      activate: async () =>
        signLicense({ licensee: "x", email: "y", plan: "pro", issuedAt: T0, expiresAt: T0 + DAY, activationId: "a" }, other),
    });
    await service.load();
    await expect(service.setLicenseKey(KEY)).rejects.toMatchObject({ status: 502 });
  });

  it("renews the lease on refresh and survives an unreachable API in grace until the lease ends", async () => {
    let apiDown = false;
    const { service, clock, calls } = harness({
      activate: async () => lease(T0, "act_1"),
      refresh: async (req) => {
        expect(req).toEqual({ key: KEY, activationId: "act_1" });
        if (apiDown) throw new LicenseApiFailure("network", "timeout after 10000 ms");
        return lease(clock.now, "act_1");
      },
    });
    await service.load();
    await service.setLicenseKey(KEY);

    // day 1: clean refresh extends the lease
    clock.now = T0 + DAY;
    let e = await service.refresh();
    expect(e.license?.status).toBe("active");
    expect(e.license?.leaseExpiresAt).toBe(T0 + 8 * DAY);

    // day 2: API down → grace, still pro
    apiDown = true;
    clock.now = T0 + 2 * DAY;
    e = await service.refresh();
    expect(e.tier).toBe("pro");
    expect(e.license?.status).toBe("grace");
    expect(e.license?.lastCheckError).toMatch(/timeout/);
    expect(e.license?.leaseExpiresAt).toBe(T0 + 8 * DAY);

    // day 9: lease ran out with no answer → free, without any call in between
    clock.now = T0 + 8 * DAY + 1;
    const cached = service.getEdition();
    expect(cached.tier).toBe("free");
    expect(cached.license?.status).toBe("expired");

    // API back: next refresh restores pro
    apiDown = false;
    clock.now = T0 + 9 * DAY;
    e = await service.refresh();
    expect(e.tier).toBe("pro");
    expect(e.license?.status).toBe("active");
    expect(calls.filter((c) => c === "refresh")).toHaveLength(3);
  });

  it("locks Pro immediately when the store says revoked, even with days left on the lease", async () => {
    const { service, clock } = harness({
      activate: async () => lease(T0, "act_1"),
      refresh: async () => {
        throw new LicenseApiFailure("license_revoked", "subscription cancelled", 403);
      },
    });
    await service.load();
    await service.setLicenseKey(KEY);
    clock.now = T0 + DAY;
    const e = await service.refresh();
    expect(e.tier).toBe("free");
    expect(e.license).toMatchObject({ status: "invalid", valid: false, lastCheckError: "subscription cancelled" });
  });

  it("re-activates when the activation was freed from the portal and the same key is pasted again", async () => {
    let activations = 0;
    const { service, calls } = harness({
      activate: async () => lease(T0, `act_${++activations}`),
      refresh: async () => {
        throw new LicenseApiFailure("license_activation_mismatch", "activation not found", 403);
      },
    });
    await service.load();
    await service.setLicenseKey(KEY);
    const e = await service.setLicenseKey(KEY);
    expect(calls).toEqual(["activate", "refresh", "activate"]);
    expect(e.license?.activationId).toBe("act_2");
  });

  it("releases the activation on remove and on replacing the key", async () => {
    const released: string[] = [];
    const { service, store } = harness({
      activate: async (req) => lease(T0, req.key === KEY ? "act_1" : "act_2"),
      deactivate: async (req) => {
        released.push(req.activationId);
      },
    });
    await service.load();
    await service.setLicenseKey(KEY);
    await service.setLicenseKey("BULLPANE-OTHER-KEY-0000");
    expect(released).toEqual(["act_1"]);
    const e = await service.clearLicenseKey();
    expect(released).toEqual(["act_1", "act_2"]);
    expect(e.tier).toBe("free");
    expect(store.map.size).toBe(0);
  });

  it("still removes the key when the release call fails", async () => {
    const { service, logs } = harness({
      activate: async () => lease(T0, "act_1"),
      deactivate: async () => {
        throw new LicenseApiFailure("network", "down");
      },
    });
    await service.load();
    await service.setLicenseKey(KEY);
    const e = await service.clearLicenseKey();
    expect(e.tier).toBe("free");
    expect(logs.some((m) => /could not release/.test(m))).toBe(true);
  });

  it("activates BULLPANE_LICENSE_KEY on the first refresh after boot, then reloads from settings", async () => {
    const store = new MemorySettingsStore();
    const first = harness({ activate: async () => lease(T0, "act_env") }, { env: { BULLPANE_LICENSE_KEY: KEY }, store });
    let e = await first.service.load();
    expect(e.tier).toBe("free");
    expect(first.service.needsRefresh(true)).toBe(true);
    e = await first.service.refresh();
    expect(e.tier).toBe("pro");
    expect(first.calls).toEqual(["activate"]);

    // Restart: the stored activation is used, no second activation.
    const second = harness({}, { env: { BULLPANE_LICENSE_KEY: KEY }, store });
    e = await second.service.load();
    expect(e.tier).toBe("pro");
    expect(second.calls).toEqual([]);
    // Checked a moment ago → the boot tick stays quiet.
    expect(second.service.needsRefresh(true)).toBe(false);
    second.clock.now = T0 + 2 * 60 * 60 * 1000;
    expect(second.service.needsRefresh(true)).toBe(true);
  });

  it("keeps running the free edition when BULLPANE_LICENSE_KEY is rejected, and retries later", async () => {
    const { service, logs, calls } = harness(
      {
        activate: async () => {
          throw new LicenseApiFailure("license_not_found", "no such key", 404);
        },
      },
      { env: { BULLPANE_LICENSE_KEY: KEY } },
    );
    await service.load();
    const e = await service.refresh();
    expect(e.tier).toBe("free");
    expect(logs.some((m) => /rejected by the store/.test(m))).toBe(true);
    await service.refresh();
    expect(calls).toEqual(["activate", "activate"]);
  });

  it("switching to an offline token releases the online activation", async () => {
    const released: string[] = [];
    const { service } = harness({
      activate: async () => lease(T0, "act_1"),
      deactivate: async (req) => {
        released.push(req.activationId);
      },
    });
    await service.load();
    await service.setLicenseKey(KEY);
    const offline = signLicense({ licensee: "Acme", email: "ops@acme.test", plan: "pro", issuedAt: T0, expiresAt: null }, privateKey);
    const e = await service.setLicenseKey(offline);
    expect(released).toEqual(["act_1"]);
    expect(e.license).toMatchObject({ source: "offline", billing: "perpetual", status: "active" });
    expect(service.needsRefresh(false)).toBe(false);
  });
});
