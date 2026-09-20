/**
 * The SSO login flow: /auth/sso/options, /auth/sso/:id/start, /auth/sso/:id/callback.
 *
 * These routes are UNAUTHENTICATED by necessity — they are how somebody becomes
 * authenticated. Three consequences shaped the code:
 *
 * 1. NOT WRAPPED IN requireFeature(). A `preHandler` gate returning 402 would be
 *    wrong here: the check is inside the handler so an expired license degrades
 *    to "SSO is off, use your password" instead of a JSON error page mid-redirect.
 *
 * 2. THE FLOW STATE LIVES IN A SIGNED COOKIE, not in server memory. A dashboard
 *    behind two replicas would otherwise fail every other login, and an
 *    in-memory map is a leak an anonymous caller can drive. The cookie holds
 *    state + nonce + PKCE verifier, is httpOnly, SameSite=Lax (the IdP
 *    redirects back top-level, so Lax is enough and Strict would drop it), and
 *    is deleted the moment the callback consumes it.
 *
 * 3. FAILURES REDIRECT TO THE LOGIN PAGE with a short reason, never a JSON 500:
 *    the user is in a browser mid-redirect. The detail goes to the log and the
 *    audit trail; the person sees one actionable sentence.
 */
import type { SsoLoginOptions, SsoTestResult, User } from "@bullpane/shared";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { SESSION_COOKIE, sessionCookieOptions } from "../auth/sessions";
import { safeEqual } from "../auth/sso/crypto";
import { authorizationUrl, createPkce, discover, exchangeCode, fetchJwks, OidcError, randomToken, verifyIdToken } from "../auth/sso/oidc";
import { createSaml, emailFromProfile, nameFromProfile, RequestIdCache, SamlError } from "../auth/sso/saml";
import type { SsoProviderRow } from "../db/schema";
import { HttpError, validation } from "../plugins/errors";

/** Holds the in-flight OIDC/SAML state. Name is per provider so two tabs on two providers do not clash. */
const FLOW_COOKIE_PREFIX = "bullpane_sso_";
/** A login flow is a few seconds of human time; 10 minutes is generous. */
const FLOW_TTL_MS = 10 * 60 * 1000;

function flowCookieName(providerId: string): string {
  return `${FLOW_COOKIE_PREFIX}${providerId}`;
}

interface FlowState {
  state: string;
  nonce: string;
  verifier?: string;
  /** Where to land after login. Validated to be a local path before it is stored. */
  next?: string;
  createdAt: number;
}

/**
 * An open redirect in a login flow is a phishing primitive: the attacker sends
 * a link to the customer's own dashboard which bounces to their page after a
 * real login. So only a local absolute path survives.
 */
export function safeNext(raw: unknown): string | undefined {
  if (typeof raw !== "string" || raw === "") return undefined;
  if (!raw.startsWith("/") || raw.startsWith("//")) return undefined;
  if (raw.includes("\\") || /[\r\n]/.test(raw)) return undefined;
  return raw;
}

/** The SAML InResponseTo cache. One per process: it only ever holds ids we issued. */
const samlRequestIds = new RequestIdCache();

export async function authSsoRoutes(app: FastifyInstance): Promise<void> {
  const { config } = app.ctx;

  function ssoEnabled(): boolean {
    return app.ctx.edition.getEdition().features.sso;
  }

  function flowCookieOptions(maxAgeMs: number) {
    return {
      path: "/api/auth/sso",
      httpOnly: true,
      sameSite: "lax" as const,
      secure: config.publicUrl.startsWith("https://"),
      signed: true,
      maxAge: Math.floor(maxAgeMs / 1000),
    };
  }

  function setFlow(reply: FastifyReply, providerId: string, state: FlowState): void {
    reply.setCookie(flowCookieName(providerId), JSON.stringify(state), flowCookieOptions(FLOW_TTL_MS));
  }

  function readFlow(request: FastifyRequest, reply: FastifyReply, providerId: string): FlowState | null {
    const raw = request.cookies[flowCookieName(providerId)];
    // Always clear it: consumed or invalid, this cookie is single-use.
    reply.clearCookie(flowCookieName(providerId), { ...flowCookieOptions(0), signed: false });
    if (!raw) return null;
    const unsigned = request.unsignCookie(raw);
    if (!unsigned.valid || unsigned.value === null) return null;
    try {
      const parsed = JSON.parse(unsigned.value) as FlowState;
      if (typeof parsed.state !== "string" || typeof parsed.nonce !== "string") return null;
      if (typeof parsed.createdAt !== "number" || parsed.createdAt + FLOW_TTL_MS < Date.now()) return null;
      return parsed;
    } catch {
      return null;
    }
  }

  /** Login page → "/login?sso_error=..." with a short, human reason. */
  function fail(reply: FastifyReply, reason: string): FastifyReply {
    const url = `/login?sso_error=${encodeURIComponent(reason)}`;
    return reply.redirect(url, 302);
  }

  /**
   * Shared tail of both protocols: an asserted email becomes a session, or it
   * does not. The pre-provisioned rule lives here, once.
   */
  async function completeLogin(args: {
    request: FastifyRequest;
    reply: FastifyReply;
    provider: SsoProviderRow;
    email: string | null;
    next?: string;
  }): Promise<FastifyReply> {
    const { request, reply, provider } = args;
    if (!args.email) {
      request.log.warn({ provider: provider.id }, "sso assertion carried no email");
      request.auditTarget({ action: "auth.sso_denied" });
      request.auditDetail({ provider: provider.name, reason: "no_email_in_assertion" });
      return fail(reply, "Your identity provider did not send an email address. Ask an admin to check the attribute mapping.");
    }
    const user = await app.ctx.sso.resolveUser(args.email);
    if (!user) {
      /**
       * The IdP authenticated somebody with no account here. This is the
       * expected outcome of the pre-provisioned model, not an attack — and the
       * audit row is how the admin learns who to invite. The email IS recorded
       * (unlike a failed password login, where recording it would build an
       * enumeration oracle): here the IdP has already vouched for the person.
       */
      request.log.info({ provider: provider.id }, "sso login refused: no account for asserted email");
      request.auditTarget({ action: "auth.sso_denied" });
      request.auditDetail({ provider: provider.name, email: args.email.toLowerCase(), reason: "not_provisioned" });
      return fail(reply, "This account is not set up in Bullpane yet. Ask an admin to add you under Users & roles.");
    }
    if (user.disabledAt) {
      // The IdP still vouches for the person; Bullpane's admin said no. Recorded
      // under the user so the audit log shows who keeps trying.
      request.log.info({ provider: provider.id, userId: user.id }, "sso login refused: account disabled");
      request.auditTarget({ action: "auth.sso_denied" });
      request.auditDetail({ provider: provider.name, email: user.email, reason: "disabled" });
      return fail(reply, "This account has been disabled. Ask an admin to re-enable it.");
    }

    const now = new Date();
    const session = await app.ctx.sessions.create(user.id, now, "sso");
    await app.ctx.users.touchLogin(user.id, now);
    reply.setCookie(SESSION_COOKIE, session.id, sessionCookieOptions(config, session.expiresAt));
    // The audit hook reads the actor from request.user, which the cookie only
    // populates on the next request — same reason as the password login.
    request.user = { ...user, lastLoginAt: now.toISOString() } as User;
    request.auditTarget({ action: "auth.sso_login" });
    request.auditDetail({ provider: provider.name, kind: provider.kind });
    request.log.info({ userId: user.id, provider: provider.id }, "sso login");
    return reply.redirect(args.next ?? "/", 302);
  }

  /**
   * What the login page needs to draw itself, before anybody is authenticated.
   * Free edition (or no providers) answers with an empty list, so the login
   * page simply shows the password form.
   */
  app.get("/auth/sso/options", async (): Promise<SsoLoginOptions> => {
    if (!ssoEnabled()) return { providers: [], requireSso: false, passwordEscapeHatch: "none" };
    return app.ctx.sso.loginOptions();
  });

  app.get<{ Params: { id: string }; Querystring: { next?: string } }>("/auth/sso/:id/start", async (request, reply) => {
    if (!ssoEnabled()) return fail(reply, "SSO is not enabled on this installation.");
    const next = safeNext(request.query.next);
    let provider: SsoProviderRow;
    try {
      provider = await app.ctx.sso.getRow(request.params.id);
    } catch {
      return fail(reply, "That sign-in method no longer exists.");
    }
    if (!provider.enabled) return fail(reply, "That sign-in method is disabled.");

    try {
      if (provider.kind === "oidc") {
        const cfg = provider.config as { issuer: string; clientId: string; scopes?: string[] };
        const discovery = await discover(cfg.issuer);
        const { verifier, challenge } = createPkce();
        const state = randomToken();
        const nonce = randomToken();
        setFlow(reply, provider.id, { state, nonce, verifier, ...(next ? { next } : {}), createdAt: Date.now() });
        const url = authorizationUrl({
          discovery,
          config: cfg,
          redirectUri: app.ctx.sso.callbackUrl(provider.id),
          state,
          nonce,
          challenge,
        });
        return reply.redirect(url, 302);
      }

      const cfg = provider.config as { entryPoint: string; issuer: string; idpCert: string };
      const saml = createSaml({
        config: cfg,
        callbackUrl: app.ctx.sso.callbackUrl(provider.id),
        entityId: app.ctx.sso.entityId(),
        cache: samlRequestIds,
      });
      const relayState = randomToken();
      // SAML has no nonce; InResponseTo (via the cache) is the replay defence,
      // and RelayState is the CSRF binding, so it is stored like OIDC's state.
      setFlow(reply, provider.id, { state: relayState, nonce: relayState, ...(next ? { next } : {}), createdAt: Date.now() });
      const url = await saml.getAuthorizeUrlAsync(relayState, undefined, {});
      return reply.redirect(url, 302);
    } catch (err) {
      const publicMessage =
        err instanceof OidcError || err instanceof SamlError ? err.publicMessage : "Could not start the SSO sign-in.";
      request.log.error({ err, provider: provider.id }, "sso start failed");
      return fail(reply, publicMessage);
    }
  });

  /**
   * OIDC comes back as a GET with ?code&state; SAML posts a form with
   * SAMLResponse+RelayState. One route, two bindings, because the IdP decides
   * the method and the admin should not have to configure two URLs.
   */
  app.route<{ Params: { id: string } }>({
    method: ["GET", "POST"],
    url: "/auth/sso/:id/callback",
    handler: async (request, reply) => {
      if (!ssoEnabled()) return fail(reply, "SSO is not enabled on this installation.");
      let provider: SsoProviderRow;
      try {
        provider = await app.ctx.sso.getRow(request.params.id);
      } catch {
        return fail(reply, "That sign-in method no longer exists.");
      }
      if (!provider.enabled) return fail(reply, "That sign-in method is disabled.");

      const flow = readFlow(request, reply, provider.id);
      if (!flow) {
        /**
         * No cookie means: it expired, the browser dropped it, or this callback
         * was not started here (CSRF). All three are refused identically.
         */
        return fail(reply, "This sign-in link expired or was not started here. Please try again.");
      }

      try {
        if (provider.kind === "oidc") {
          const query = request.query as { code?: string; state?: string; error?: string; error_description?: string };
          if (query.error) {
            request.log.warn({ provider: provider.id, error: query.error }, "idp returned an error");
            return fail(reply, `Your identity provider refused the sign-in (${query.error}).`);
          }
          if (!query.code || !query.state) return fail(reply, "The identity provider's response was incomplete.");
          if (!safeEqual(query.state, flow.state)) return fail(reply, "This sign-in could not be verified. Please try again.");

          const cfg = provider.config as { issuer: string; clientId: string; emailClaim?: string };
          const discovery = await discover(cfg.issuer);
          const { idToken } = await exchangeCode({
            discovery,
            config: cfg,
            clientSecret: app.ctx.sso.clientSecretFor(provider),
            code: query.code,
            redirectUri: app.ctx.sso.callbackUrl(provider.id),
            verifier: flow.verifier ?? "",
          });
          const jwks = await fetchJwks(discovery.jwksUri);
          const claims = verifyIdToken({
            idToken,
            jwks,
            expectedIssuer: discovery.issuer,
            clientId: cfg.clientId,
            expectedNonce: flow.nonce,
            ...(cfg.emailClaim ? { emailClaim: cfg.emailClaim } : {}),
          });
          return completeLogin({ request, reply, provider, email: claims.email, ...(flow.next ? { next: flow.next } : {}) });
        }

        const body = (request.body ?? {}) as { SAMLResponse?: string; RelayState?: string };
        if (!body.SAMLResponse) return fail(reply, "The identity provider's response was incomplete.");
        if (!body.RelayState || !safeEqual(body.RelayState, flow.state)) {
          return fail(reply, "This sign-in could not be verified. Please try again.");
        }
        const cfg = provider.config as { entryPoint: string; issuer: string; idpCert: string };
        const saml = createSaml({
          config: cfg,
          callbackUrl: app.ctx.sso.callbackUrl(provider.id),
          entityId: app.ctx.sso.entityId(),
          cache: samlRequestIds,
        });
        const { profile } = await saml.validatePostResponseAsync({ SAMLResponse: body.SAMLResponse });
        if (!profile) return fail(reply, "The identity provider's assertion could not be read.");
        const email = emailFromProfile(profile, app.ctx.sso.samlEmailAttribute(provider.config));
        void nameFromProfile(profile);
        return completeLogin({ request, reply, provider, email, ...(flow.next ? { next: flow.next } : {}) });
      } catch (err) {
        const publicMessage =
          err instanceof OidcError || err instanceof SamlError
            ? err.publicMessage
            : err instanceof HttpError
              ? err.message
              : "The SSO sign-in failed.";
        request.log.error({ err, provider: provider.id }, "sso callback failed");
        request.auditTarget({ action: "auth.sso_denied" });
        request.auditDetail({ provider: provider.name, reason: "verification_failed" });
        return fail(reply, publicMessage);
      }
    },
  });
}

/** Exported for the admin route's "test connection". */
export async function testProvider(row: SsoProviderRow, callbackUrl: string, entityId: string): Promise<SsoTestResult> {
  if (row.kind === "oidc") {
    const cfg = row.config as { issuer: string };
    const discovery = await discover(cfg.issuer);
    return {
      ok: true,
      message: "Discovery succeeded. Check the endpoints below, then try signing in.",
      details: {
        issuer: discovery.issuer,
        authorization_endpoint: discovery.authorizationEndpoint,
        token_endpoint: discovery.tokenEndpoint,
        jwks_uri: discovery.jwksUri,
        redirect_uri: callbackUrl,
      },
    };
  }
  // SAML has nothing to discover: validate what we can locally and hand the
  // admin the two values the IdP needs.
  const cfg = row.config as { entryPoint: string; idpCert: string };
  createSaml({ config: cfg as never, callbackUrl, entityId, cache: new RequestIdCache() });
  if (!cfg.entryPoint) throw validation("The SAML entry point is missing.");
  return {
    ok: true,
    message: "The certificate parses and the entry point is set. Enter these values at your IdP, then try signing in.",
    details: { entity_id: entityId, acs_url: callbackUrl, entry_point: cfg.entryPoint },
  };
}
