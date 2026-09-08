/**
 * Pro-feature gate and demo lock. Both are preHandlers.
 * Per docs/API.md the pro gate runs BEFORE the role check, so a viewer on the
 * free edition gets a 402 upsell rather than a 403.
 */
import type { Edition, ProFeature } from "@bullpane/shared";
import type { FastifyReply, FastifyRequest } from "fastify";
import { demoLocked, proRequired, readOnlyLocked } from "./errors";

export function assertFeature(edition: Edition, feature: ProFeature): void {
  if (!edition.features[feature]) throw proRequired(feature);
}

export function requireFeature(feature: ProFeature) {
  return async function featureGate(request: FastifyRequest, _reply: FastifyReply): Promise<void> {
    assertFeature(request.server.ctx.edition.getEdition(), feature);
  };
}

export async function blockInDemo(request: FastifyRequest, _reply: FastifyReply): Promise<void> {
  if (request.server.ctx.config.readOnly) throw readOnlyLocked();
  if (request.server.ctx.config.demoMode) throw demoLocked();
}

/**
 * Registered globally in read-only mode: every non-GET /api request is refused
 * before it reaches a handler, so no route can be forgotten. Login and logout
 * are POSTs that change no queue state, so they stay allowed.
 */
const WRITE_ALLOWLIST = new Set(["/api/auth/login", "/api/auth/logout"]);

/**
 * The SAML assertion comes back as an HTTP-POST from the IdP, so signing in is
 * a POST whose path contains a provider id. Read-only mode is about not
 * touching the customer's queues — it was never meant to stop people logging
 * in, and blocking this would make SSO unusable on exactly the installs
 * (production, watched carefully) most likely to enable it.
 *
 * Narrow on purpose: only the callback. The admin CRUD under /api/sso/* stays
 * blocked, because that IS a configuration write.
 */
const SSO_CALLBACK = /^\/api\/auth\/sso\/[A-Za-z0-9_-]+\/callback$/;

export function isLoginWrite(pathOnly: string): boolean {
  return WRITE_ALLOWLIST.has(pathOnly) || SSO_CALLBACK.test(pathOnly);
}

export async function blockWrites(request: FastifyRequest, _reply: FastifyReply): Promise<void> {
  if (!request.server.ctx.config.readOnly) return;
  const method = request.method.toUpperCase();
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") return;
  const pathOnly = request.url.split("?")[0] ?? request.url;
  if (isLoginWrite(pathOnly)) return;
  throw readOnlyLocked();
}
