/**
 * Client for the license API (api.bullpane.com). The dashboard never talks to
 * the store (Creem) directly: the API activates the key there and answers with
 * an Ed25519-signed lease that the server verifies like any offline token.
 *
 * Only the key, an instance label and the activation id ever leave the server.
 */
import {
  LICENSE_API_ERROR_CODES,
  type LicenseActivateRequest,
  type LicenseApiError,
  type LicenseApiErrorCode,
  type LicenseLeaseResponse,
  type LicenseRefreshRequest,
} from "@bullpane/shared";

export class LicenseApiFailure extends Error {
  constructor(
    /** an API code, or "network" when no answer came back at all */
    readonly code: LicenseApiErrorCode | "network",
    message: string,
    readonly status: number | null = null,
  ) {
    super(message);
    this.name = "LicenseApiFailure";
  }
}

export interface LicenseClient {
  /** Returns the signed lease. Throws LicenseApiFailure. */
  activate(req: LicenseActivateRequest): Promise<string>;
  /** Returns a fresh signed lease for an existing activation. Throws LicenseApiFailure. */
  refresh(req: LicenseRefreshRequest): Promise<string>;
  /** Frees the activation so the key can be used on another install. Throws LicenseApiFailure. */
  deactivate(req: LicenseRefreshRequest): Promise<void>;
}

export interface HttpLicenseClientOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** sent as User-Agent so the API can tell versions apart */
  userAgent?: string;
}

function isApiErrorCode(v: unknown): v is LicenseApiErrorCode {
  return typeof v === "string" && (LICENSE_API_ERROR_CODES as readonly string[]).includes(v);
}

export class HttpLicenseClient implements LicenseClient {
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly userAgent: string;

  constructor(
    private readonly baseUrl: string,
    opts: HttpLicenseClientOptions = {},
  ) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 10_000;
    this.userAgent = opts.userAgent ?? "bullpane-server";
  }

  async activate(req: LicenseActivateRequest): Promise<string> {
    const body = await this.post<LicenseLeaseResponse>("/v1/license/activate", req);
    return body.lease;
  }

  async refresh(req: LicenseRefreshRequest): Promise<string> {
    const body = await this.post<LicenseLeaseResponse>("/v1/license/refresh", req);
    return body.lease;
  }

  async deactivate(req: LicenseRefreshRequest): Promise<void> {
    await this.post<null>("/v1/license/deactivate", req);
  }

  private async post<T>(path: string, payload: unknown): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json", "user-agent": this.userAgent },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
    } catch (err) {
      const reason = err instanceof Error && err.name === "AbortError" ? `timeout after ${this.timeoutMs} ms` : errorText(err);
      throw new LicenseApiFailure("network", reason);
    } finally {
      clearTimeout(timer);
    }

    if (response.status === 204) return null as T;
    const text = await response.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }

    if (response.ok) {
      if (json === null || typeof json !== "object") throw new LicenseApiFailure("upstream_unavailable", "license server sent no body", response.status);
      return json as T;
    }

    const apiError = json as Partial<LicenseApiError> | null;
    const code = isApiErrorCode(apiError?.error) ? apiError.error : "upstream_unavailable";
    const message = typeof apiError?.message === "string" && apiError.message ? apiError.message : `license server answered ${response.status}`;
    throw new LicenseApiFailure(code, message, response.status);
  }
}

function errorText(err: unknown): string {
  if (err instanceof Error) return err.cause instanceof Error ? `${err.message} (${err.cause.message})` : err.message;
  return String(err);
}
