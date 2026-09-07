/**
 * Thin client for Polar's customer-portal license-key endpoints. They need no
 * API token: the key itself is the credential, scoped by organization id.
 * https://polar.sh/docs/features/benefits/license-keys
 */
import type { LicenseApiErrorCode } from "@bullmq-visualizer/shared";

export class ApiFail extends Error {
  constructor(
    readonly code: LicenseApiErrorCode,
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ApiFail";
  }
}

export interface PolarCustomer {
  email?: string | null;
  name?: string | null;
}

export interface PolarLicenseKey {
  id: string;
  status: "granted" | "revoked" | "disabled" | string;
  expires_at: string | null;
  limit_activations: number | null;
  usage?: number;
  customer?: PolarCustomer | null;
  /** older payloads */
  user?: PolarCustomer | null;
  display_key?: string;
}

export interface PolarActivation {
  id: string;
  license_key_id: string;
  label: string;
  created_at: string;
  license_key: PolarLicenseKey;
}

export interface PolarValidation extends PolarLicenseKey {
  activation?: { id: string; label: string } | null;
}

export interface PolarClientOptions {
  base: string;
  organizationId: string;
  fetchImpl: typeof fetch;
}

const HTTP_TO_CODE = (status: number, detail: string): LicenseApiErrorCode => {
  if (status === 404) return "license_not_found";
  if (status === 422) return "license_not_found";
  if (status >= 500) return "upstream_unavailable";
  if (/limit/i.test(detail)) return "license_activation_limit";
  if (/expired/i.test(detail)) return "license_expired";
  if (/activation/i.test(detail)) return "license_activation_mismatch";
  return "license_revoked";
};

const HUMAN: Record<LicenseApiErrorCode, string> = {
  license_not_found: "This key does not exist. Check the receipt from bullpane.com and paste the whole key.",
  license_activation_limit: "This key is already active on another installation. Remove it there (Settings → License) or from your Bullpane customer portal, then try again.",
  license_revoked: "This key was revoked or the subscription was cancelled.",
  license_expired: "The paid period for this key has ended. Renew it on bullpane.com.",
  license_activation_mismatch: "This installation's activation no longer exists in the store. Paste the key again to activate.",
  upstream_unavailable: "The store could not be reached. Nothing changed; try again in a minute.",
  validation: "Malformed request.",
};

export class PolarClient {
  constructor(private readonly opts: PolarClientOptions) {}

  async activate(key: string, label: string, meta: Record<string, string>): Promise<PolarActivation> {
    return this.post<PolarActivation>("/v1/customer-portal/license-keys/activate", {
      key,
      organization_id: this.opts.organizationId,
      label,
      meta,
    });
  }

  async validate(key: string, activationId: string): Promise<PolarValidation> {
    const result = await this.post<PolarValidation>("/v1/customer-portal/license-keys/validate", {
      key,
      organization_id: this.opts.organizationId,
      activation_id: activationId,
    });
    // Belt and braces: Polar answers 403 for these, but a 200 must not slip through either.
    if (result.status !== "granted") throw new ApiFail("license_revoked", HUMAN.license_revoked, 403);
    if (result.expires_at && Date.parse(result.expires_at) <= Date.now()) throw new ApiFail("license_expired", HUMAN.license_expired, 403);
    if (result.activation && result.activation.id !== activationId) {
      throw new ApiFail("license_activation_mismatch", HUMAN.license_activation_mismatch, 403);
    }
    return result;
  }

  async deactivate(key: string, activationId: string): Promise<void> {
    await this.post<null>("/v1/customer-portal/license-keys/deactivate", {
      key,
      organization_id: this.opts.organizationId,
      activation_id: activationId,
    });
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    let response: Response;
    try {
      response = await this.opts.fetchImpl(`${this.opts.base}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json", "user-agent": "bullpane-license-api" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(8_000),
      });
    } catch (err) {
      console.warn("polar fetch failed", path, err instanceof Error ? `${err.name}: ${err.message}` : String(err));
      throw new ApiFail("upstream_unavailable", HUMAN.upstream_unavailable, 502);
    }
    if (response.status === 204) return null as T;
    const text = await response.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    if (response.ok) return json as T;

    const detail = extractDetail(json);
    // Never log the key; status + Polar's wording is enough to debug.
    console.warn("polar refused", path, response.status, detail || text.slice(0, 200));
    const code = HTTP_TO_CODE(response.status, detail);
    // The store's wording is kept for the logs; the customer sees our sentence.
    const fail = new ApiFail(code, HUMAN[code], code === "upstream_unavailable" ? 502 : statusFor(code));
    fail.cause = detail || `polar ${response.status}`;
    throw fail;
  }
}

export function statusFor(code: LicenseApiErrorCode): number {
  switch (code) {
    case "license_not_found":
      return 404;
    case "license_activation_limit":
      return 409;
    case "validation":
      return 400;
    case "upstream_unavailable":
      return 502;
    default:
      return 403;
  }
}

function extractDetail(json: unknown): string {
  if (!json || typeof json !== "object") return "";
  const detail = (json as { detail?: unknown }).detail;
  if (typeof detail === "string") return detail;
  if (Array.isArray(detail)) return detail.map((d) => (typeof d === "object" && d && "msg" in d ? String((d as { msg: unknown }).msg) : String(d))).join("; ");
  const error = (json as { error?: unknown }).error;
  return typeof error === "string" ? error : "";
}
