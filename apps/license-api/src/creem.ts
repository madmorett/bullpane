/**
 * Creem license endpoints (https://docs.creem.io/api-reference/endpoint/activate-license).
 *
 *   POST /v1/licenses/activate    { key, instance_name }  → LicenseEntity (+ instance)
 *   POST /v1/licenses/validate    { key, instance_id }    → LicenseEntity
 *   POST /v1/licenses/deactivate  { key, instance_id }    → LicenseEntity
 *
 * Authenticated with the store API key (x-api-key), which is why the dashboard
 * never calls Creem directly: the key lives only in this Worker.
 *
 * LicenseEntity.status: active | inactive | expired | disabled.
 * instance.status:      active | deactivated.
 */
import { ApiFail, extractDetail, HUMAN, type StoreClient, type StoreLicense, statusFor } from "./store";

export interface CreemInstance {
  id: string;
  name?: string;
  status: "active" | "deactivated" | string;
  created_at?: string;
}

export interface CreemLicense {
  id: string;
  mode?: string;
  product_id?: string;
  status: "active" | "inactive" | "expired" | "disabled" | string;
  key: string;
  activation?: number;
  activation_limit?: number | null;
  expires_at: string | null;
  created_at?: string;
  instance?: CreemInstance | null;
  /** not in the documented schema, read defensively if present */
  customer?: { email?: string | null; name?: string | null } | null;
}

export interface CreemClientOptions {
  base: string;
  apiKey: string;
  fetchImpl: typeof fetch;
}

function codeFor(status: number, detail: string): ApiFail["code"] {
  if (status === 404) return "license_not_found";
  if (status === 401) return "upstream_unavailable"; // our key, not the customer's
  if (status >= 500) return "upstream_unavailable";
  if (/limit|maximum|no more activations/i.test(detail)) return "license_activation_limit";
  if (/expired/i.test(detail)) return "license_expired";
  if (/instance/i.test(detail)) return "license_activation_mismatch";
  if (/not found|invalid (license )?key|does not exist/i.test(detail)) return "license_not_found";
  if (/inactive|disabled|revoked|cancel/i.test(detail)) return "license_revoked";
  return "license_revoked";
}

function toStoreLicense(lic: CreemLicense, activationId: string): StoreLicense {
  const c = lic.customer ?? null;
  const email = (c?.email ?? "").trim();
  const tail = lic.key.slice(-4);
  return {
    activationId,
    // Creem's license entity carries no customer fields; the receipt does.
    licensee: (c?.name ?? "").trim() || `Bullpane Pro · key ····${tail}`,
    email: email || "see your bullpane.com receipt",
    subscriptionExpiresAt: lic.expires_at ? Date.parse(lic.expires_at) : null,
  };
}

/** A 200 whose body says the key is not usable is still a refusal. */
function assertUsable(lic: CreemLicense, expectedInstance: string | null): void {
  if (lic.status === "expired") throw new ApiFail("license_expired", HUMAN.license_expired, 403);
  if (lic.status !== "active") throw new ApiFail("license_revoked", HUMAN.license_revoked, 403);
  if (lic.expires_at && Date.parse(lic.expires_at) <= Date.now()) throw new ApiFail("license_expired", HUMAN.license_expired, 403);
  if (expectedInstance) {
    if (!lic.instance || lic.instance.id !== expectedInstance || lic.instance.status !== "active") {
      throw new ApiFail("license_activation_mismatch", HUMAN.license_activation_mismatch, 403);
    }
  }
}

export class CreemClient implements StoreClient {
  constructor(private readonly opts: CreemClientOptions) {}

  async activate(key: string, label: string, _meta: Record<string, string>): Promise<StoreLicense> {
    const lic = await this.post("/v1/licenses/activate", { key, instance_name: label });
    if (!lic.instance?.id) throw new ApiFail("upstream_unavailable", "store answered without an instance id", 502);
    assertUsable(lic, null);
    return toStoreLicense(lic, lic.instance.id);
  }

  async validate(key: string, activationId: string): Promise<StoreLicense> {
    const lic = await this.post("/v1/licenses/validate", { key, instance_id: activationId });
    assertUsable(lic, activationId);
    return toStoreLicense(lic, activationId);
  }

  async deactivate(key: string, activationId: string): Promise<void> {
    await this.post("/v1/licenses/deactivate", { key, instance_id: activationId });
  }

  private async post(path: string, body: unknown): Promise<CreemLicense> {
    let response: Response;
    try {
      response = await this.opts.fetchImpl(`${this.opts.base}${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
          "x-api-key": this.opts.apiKey,
          "user-agent": "bullpane-license-api",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(8_000),
      });
    } catch (err) {
      console.warn("creem fetch failed", path, err instanceof Error ? `${err.name}: ${err.message}` : String(err));
      throw new ApiFail("upstream_unavailable", HUMAN.upstream_unavailable, 502);
    }
    const text = await response.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    if (response.ok) {
      if (!json || typeof json !== "object") throw new ApiFail("upstream_unavailable", "store sent no body", 502);
      return json as CreemLicense;
    }
    const detail = extractDetail(json);
    // Never log the key; status + the store's wording is enough to debug.
    console.warn("creem refused", path, response.status, detail || text.slice(0, 200));
    const code = codeFor(response.status, detail);
    const fail = new ApiFail(code, HUMAN[code], statusFor(code));
    fail.cause = detail || `creem ${response.status}`;
    throw fail;
  }
}
