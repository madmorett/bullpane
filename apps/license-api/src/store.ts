/**
 * What the license API needs from a store, whichever store it is. Polar was the
 * first implementation (payouts turned out not to reach Brazil); Creem is the
 * current one. Keeping this seam means the dashboard never learns which store
 * is behind api.bullpane.com.
 */
import type { LicenseApiErrorCode } from "@bullpane/shared";

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

/** What a lease is built from. */
export interface StoreLicense {
  /** the store's id for this installation's activation */
  activationId: string;
  licensee: string;
  email: string;
  /** end of the paid period, unix ms; null = open subscription / unknown */
  subscriptionExpiresAt: number | null;
}

export interface StoreClient {
  /** Activate `key` for a new installation labelled `label`. Throws ApiFail. */
  activate(key: string, label: string, meta: Record<string, string>): Promise<StoreLicense>;
  /** Confirm `key` is still good for `activationId`. Throws ApiFail. */
  validate(key: string, activationId: string): Promise<StoreLicense>;
  /** Free the activation. Throws ApiFail (not_found / mismatch are fine to ignore). */
  deactivate(key: string, activationId: string): Promise<void>;
}

/** The sentence the admin sees in Settings → License, per code. The store's own wording goes to the logs. */
export const HUMAN: Record<LicenseApiErrorCode, string> = {
  license_not_found: "This key does not exist. Check the receipt from bullpane.com and paste the whole key.",
  license_activation_limit:
    "This key is already active on another installation. Remove it there (Settings → License) or ask hello@bullpane.com to free it, then try again.",
  license_revoked: "This key was revoked or the subscription was cancelled.",
  license_expired: "The paid period for this key has ended. Renew it on bullpane.com.",
  license_activation_mismatch: "This installation's activation no longer exists in the store. Paste the key again to activate.",
  upstream_unavailable: "The store could not be reached. Nothing changed; try again in a minute.",
  validation: "Malformed request.",
};

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

/** Pull a human-readable message out of whatever JSON error body a store sends. */
export function extractDetail(json: unknown): string {
  if (!json || typeof json !== "object") return "";
  const o = json as Record<string, unknown>;
  for (const field of ["message", "detail", "error"]) {
    const v = o[field];
    if (typeof v === "string") return v;
    if (Array.isArray(v)) return v.map((d) => (typeof d === "object" && d && "msg" in d ? String((d as { msg: unknown }).msg) : String(d))).join("; ");
  }
  return "";
}
