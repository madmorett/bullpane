/**
 * The guard that makes auto-provisioning safe to offer: it can never be on
 * without a domain list, because "anyone the IdP authenticates" is, for a
 * Google OIDC client, every Google account.
 */
import { ssoSettingsSchema } from "@bullpane/shared";
import { describe, expect, it, vi } from "vitest";
import type { Db } from "../db";
import { MemorySettingsStore } from "../services/settings-store";
import { SsoService } from "../services/sso";

function service() {
  const settings = new MemorySettingsStore();
  const create = vi.fn();
  const sso = new SsoService({} as Db, { publicUrl: "https://x.test", sessionSecret: "s".repeat(40), allowPasswordLogin: false }, settings, { create });
  return { sso, settings, create };
}

describe("SSO auto-provision settings", () => {
  it("defaults to off with no domains", async () => {
    const { sso } = service();
    expect(await sso.getSettings()).toEqual({ requireSso: false, autoProvision: false, autoProvisionDomains: [] });
  });

  it("refuses to turn on without a domain", async () => {
    const { sso } = service();
    await expect(sso.updateSettings({ autoProvision: true })).rejects.toThrow(/at least one email domain/);
  });

  it("turns on with domains, and refuses to remove the last one while on", async () => {
    const { sso } = service();
    const on = await sso.updateSettings({ autoProvision: true, autoProvisionDomains: ["acme.test", "acme.test", "other.test"] });
    expect(on).toMatchObject({ autoProvision: true, autoProvisionDomains: ["acme.test", "other.test"] });
    await expect(sso.updateSettings({ autoProvisionDomains: [] })).rejects.toThrow(/at least one email domain/);
    const off = await sso.updateSettings({ autoProvision: false, autoProvisionDomains: [] });
    expect(off).toMatchObject({ autoProvision: false, autoProvisionDomains: [] });
  });

  it("does not call create when the toggle is off", async () => {
    const { sso, create } = service();
    await sso.updateSettings({ autoProvisionDomains: ["acme.test"] });
    expect(await sso.provisionUser({ email: "a@acme.test", name: null, emailVerified: true })).toBeNull();
    expect(create).not.toHaveBeenCalled();
  });

  it("normalises domains and rejects garbage at the schema", () => {
    expect(ssoSettingsSchema.parse({ autoProvisionDomains: [" @Acme.COM "] }).autoProvisionDomains).toEqual(["acme.com"]);
    for (const bad of ["acme", "*.acme.com", "a@acme.com", "acme.com/x", ""]) {
      expect(ssoSettingsSchema.safeParse({ autoProvisionDomains: [bad] }).success).toBe(false);
    }
  });
});
