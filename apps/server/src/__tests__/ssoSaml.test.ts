import type { Profile } from "@node-saml/node-saml";
import { describe, expect, it, vi } from "vitest";
import { createSaml, emailFromProfile, nameFromProfile, normaliseCert, RequestIdCache, SamlError } from "../auth/sso/saml";

const CERT_BODY = "MIIC" + "a".repeat(60);

describe("normaliseCert", () => {
  it("accepts a PEM block and strips headers and whitespace", () => {
    const pem = `-----BEGIN CERTIFICATE-----\n${CERT_BODY}\n-----END CERTIFICATE-----`;
    expect(normaliseCert(pem)).toBe(CERT_BODY);
  });

  it("accepts bare base64 unchanged", () => {
    expect(normaliseCert(CERT_BODY)).toBe(CERT_BODY);
  });

  it("refuses empty and non-base64 input", () => {
    expect(() => normaliseCert("")).toThrow(SamlError);
    expect(() => normaliseCert("-----BEGIN CERTIFICATE-----\n\n-----END CERTIFICATE-----")).toThrow(/empty/);
    expect(() => normaliseCert("not a certificate!")).toThrow(/not base64/);
    // The admin-facing wording is the one that has to be actionable.
    try {
      normaliseCert("not a certificate!");
    } catch (err) {
      expect((err as SamlError).publicMessage).toMatch(/not valid base64\/PEM/);
    }
  });
});

describe("RequestIdCache — the SAML replay defence", () => {
  it("stores an id and returns it once", async () => {
    const cache = new RequestIdCache();
    await cache.saveAsync("req-1", "req-1");
    expect(await cache.getAsync("req-1")).toBe("req-1");
    expect(await cache.removeAsync("req-1")).toBe("req-1");
    // Second use is the replay, and it must find nothing.
    expect(await cache.getAsync("req-1")).toBeNull();
    expect(await cache.removeAsync("req-1")).toBeNull();
  });

  it("does not know ids it never issued", async () => {
    const cache = new RequestIdCache();
    expect(await cache.getAsync("forged-id")).toBeNull();
  });

  it("expires ids after the TTL", async () => {
    vi.useFakeTimers();
    try {
      const cache = new RequestIdCache(1000);
      await cache.saveAsync("req-1", "req-1");
      vi.advanceTimersByTime(1500);
      expect(await cache.getAsync("req-1")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("is bounded, so hammering /start cannot exhaust memory", async () => {
    const cache = new RequestIdCache(60000, 3);
    expect(await cache.saveAsync("a", "a")).not.toBeNull();
    expect(await cache.saveAsync("b", "b")).not.toBeNull();
    expect(await cache.saveAsync("c", "c")).not.toBeNull();
    expect(await cache.saveAsync("d", "d")).toBeNull();
    expect(cache.size).toBe(3);
  });

  it("sweeps expired entries so the cap is not permanent", async () => {
    vi.useFakeTimers();
    try {
      const cache = new RequestIdCache(1000, 2);
      await cache.saveAsync("a", "a");
      await cache.saveAsync("b", "b");
      expect(await cache.saveAsync("c", "c")).toBeNull();
      vi.advanceTimersByTime(1500);
      expect(await cache.saveAsync("c", "c")).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("refuses to overwrite an id already in flight", async () => {
    const cache = new RequestIdCache();
    expect(await cache.saveAsync("req-1", "req-1")).not.toBeNull();
    expect(await cache.saveAsync("req-1", "req-1")).toBeNull();
  });
});

describe("createSaml", () => {
  const args = {
    config: { entryPoint: "https://idp.example.com/sso", issuer: "idp-entity", idpCert: CERT_BODY },
    callbackUrl: "https://bull.acme.test/api/auth/sso/p1/callback",
    entityId: "https://bull.acme.test/api/auth/sso/metadata",
    cache: new RequestIdCache(),
  };

  it("pins the security options that must never be weakened", () => {
    const saml = createSaml(args);
    expect(saml.options.wantAssertionsSigned).toBe(true);
    expect(saml.options.audience).toBe(args.entityId);
    expect(saml.options.validateInResponseTo).toBe("always");
    expect(saml.options.issuer).toBe(args.entityId);
    expect(saml.options.callbackUrl).toBe(args.callbackUrl);
  });

  it("produces a redirect URL carrying SAMLRequest and RelayState", async () => {
    const saml = createSaml(args);
    const url = new URL(await saml.getAuthorizeUrlAsync("relay-1", undefined, {}));
    expect(url.origin + url.pathname).toBe("https://idp.example.com/sso");
    expect(url.searchParams.get("SAMLRequest")).toBeTruthy();
    expect(url.searchParams.get("RelayState")).toBe("relay-1");
  });

  it("rejects a response that was never requested (InResponseTo unknown)", async () => {
    const saml = createSaml(args);
    // A syntactically valid but unsolicited/garbage response must not throw
    // something unhandled — it must be refused.
    await expect(
      saml.validatePostResponseAsync({ SAMLResponse: Buffer.from("<samlp:Response/>").toString("base64") }),
    ).rejects.toBeDefined();
  });
});

describe("attribute extraction", () => {
  const base = { issuer: "idp", nameID: "x", nameIDFormat: "f" } as Profile;

  it("prefers the attribute the admin configured", () => {
    const profile = { ...base, upn: "configured@acme.test", email: "other@acme.test" } as Profile;
    expect(emailFromProfile(profile, "upn")).toBe("configured@acme.test");
  });

  it("falls back through the conventional claim URIs", () => {
    const claim = "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress";
    expect(emailFromProfile({ ...base, [claim]: "dev@acme.test" } as Profile, "missing")).toBe("dev@acme.test");
    expect(emailFromProfile({ ...base, "urn:oid:0.9.2342.19200300.100.1.3": "dev@acme.test" } as Profile, "missing")).toBe("dev@acme.test");
    expect(emailFromProfile({ ...base, mail: "dev@acme.test" } as Profile, "missing")).toBe("dev@acme.test");
  });

  it("falls back to NameID, which is the only field SAML guarantees", () => {
    expect(emailFromProfile({ ...base, nameID: "dev@acme.test" } as Profile, "missing")).toBe("dev@acme.test");
  });

  it("handles multi-valued attributes", () => {
    expect(emailFromProfile({ ...base, email: ["dev@acme.test", "alt@acme.test"] } as unknown as Profile, "email")).toBe("dev@acme.test");
  });

  it("returns null rather than guessing when there is no email", () => {
    expect(emailFromProfile({ ...base, nameID: "S-1-5-21-not-an-email" } as Profile, "missing")).toBeNull();
    // A value that is not an email must not be accepted just because the key matched.
    expect(emailFromProfile({ ...base, email: "not-an-email" } as Profile, "email")).toBeNull();
  });

  it("extracts a display name when present, null otherwise", () => {
    expect(nameFromProfile({ ...base, displayName: "Dev Person" } as Profile)).toBe("Dev Person");
    expect(nameFromProfile(base)).toBeNull();
  });
});
