/**
 * The OAuth 2.1 authorization server behind /mcp, and the access check every MCP
 * call goes through. Hand-rolled for the same reason the OIDC client is
 * (docs/ARCHITECTURE.md → SSO): it is a handful of hashes and one HMAC, and a
 * dependency tree here is one more thing a customer's security review has to read.
 *
 * What the MCP authorization spec requires, and where it is:
 *  - Protected resource metadata (RFC 9728) and AS metadata (RFC 8414): routes.ts
 *  - Dynamic client registration (RFC 7591), public clients only: registerClient
 *  - Authorization code + PKCE S256, mandatory: authorizeRequest / exchangeCode
 *  - Resource indicators (RFC 8707): the `resource` must be this server's /mcp
 *  - Refresh tokens rotate; a replayed one revokes its whole grant: refresh
 *
 * Tokens:
 *  - access  `bpat.<payload>.<hmac>`  1 h, signed, carries only the grant id.
 *  - refresh `bprt_<random>`          30 days, sliding, stored as SHA-256.
 *  - code    `bpac_<random>`          60 s, single use, stored as SHA-256.
 * Every key is derived from SESSION_SECRET with HKDF and a distinct label, so an
 * access token can never be replayed as a signed consent request or vice versa.
 */
import { createHash, createHmac, hkdfSync, randomBytes, timingSafeEqual } from "node:crypto";
import {
  MCP_ACCESS_LEVELS,
  mcpEffectiveAccess,
  type McpAccessLevel,
  type McpConsentInfo,
  type McpGrant,
  type McpGrantAccess,
  type McpSettings,
  type User,
} from "@bullpane/shared";
import { nanoid } from "nanoid";
import { toUserDto } from "../../auth/sessions";
import type { Config } from "../../config";
import type { SettingsStore } from "../../services/settings-store";
import type { McpGrantWithUser, McpStore } from "./store";

export const MCP_SETTINGS_KEY = "mcp.max_access";
export const MCP_SCOPES = { read: "queues:read", write: "queues:write" } as const;

const ACCESS_TTL_S = 60 * 60;
const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const CODE_TTL_MS = 60 * 1000;
/** The consent screen has this long between the redirect and the click. */
const REQUEST_TTL_MS = 10 * 60 * 1000;
/** Registration is unauthenticated by design (RFC 7591); these bound what that costs. */
const MAX_CLIENTS = 5000;
const UNUSED_CLIENT_TTL_MS = 24 * 60 * 60 * 1000;
/** `last_used_at` is for the humans in Settings → MCP; one write a minute per grant is plenty. */
const TOUCH_EVERY_MS = 60 * 1000;

/** An OAuth error, serialised as `{ error, error_description }` (RFC 6749 §5.2). */
export class OAuthError extends Error {
  constructor(
    readonly status: number,
    readonly error: string,
    description: string,
  ) {
    super(description);
    this.name = "OAuthError";
  }
  toBody(): { error: string; error_description: string } {
    return { error: this.error, error_description: this.message };
  }
}

/** The authorize request, validated, as carried (signed) through the consent screen. */
export interface AuthorizeRequest {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  state: string | null;
  requested: McpGrantAccess | null;
}

export interface TokenResponse {
  access_token: string;
  token_type: "Bearer";
  expires_in: number;
  refresh_token: string;
  scope: string;
}

/** Who an MCP call acts as, and with what access, right now. */
export interface McpCaller {
  user: User;
  grantId: string;
  clientName: string;
  /** min(admin ceiling, granted, role) — evaluated on this call */
  access: McpAccessLevel;
}

const b64url = (buf: Buffer): string => buf.toString("base64url");
export const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");
const random = (prefix: string): string => `${prefix}${b64url(randomBytes(32))}`;

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);
/** Schemes that execute or read locally instead of handing a code to an app. */
const FORBIDDEN_SCHEMES = new Set(["javascript:", "data:", "file:", "vbscript:", "about:", "blob:"]);

/**
 * A redirect URI a client may register: https anywhere, http only on loopback
 * (RFC 8252 §7.3, how Claude Code receives the code), or an app's private
 * scheme. Never a fragment — the code would leak into browser history.
 */
export function isAllowedRedirectUri(raw: string): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.hash || raw.length > 2048) return false;
  if (u.protocol === "https:") return true;
  if (u.protocol === "http:") return LOOPBACK.has(u.hostname);
  return !FORBIDDEN_SCHEMES.has(u.protocol) && /^[a-z][a-z0-9+.-]*:$/.test(u.protocol);
}

/** Exact match, except a loopback redirect may change port between runs (RFC 8252 §7.3). */
function redirectMatches(registered: string, presented: string): boolean {
  if (registered === presented) return true;
  try {
    const a = new URL(registered);
    const b = new URL(presented);
    return (
      a.protocol === "http:" &&
      b.protocol === "http:" &&
      LOOPBACK.has(a.hostname) &&
      a.hostname === b.hostname &&
      a.pathname === b.pathname &&
      a.search === b.search
    );
  } catch {
    return false;
  }
}

export function redirectHost(uri: string): string {
  try {
    const u = new URL(uri);
    return u.host || u.protocol.replace(/:$/, "");
  } catch {
    return uri.slice(0, 60);
  }
}

/** `queues:write` asks for write; anything else (or nothing) is not a request for write. */
export function parseScope(scope: string | undefined | null): McpGrantAccess | null {
  if (!scope) return null;
  const parts = scope.split(/\s+/);
  if (parts.includes(MCP_SCOPES.write)) return "write";
  if (parts.includes(MCP_SCOPES.read)) return "read";
  return null;
}

export function scopeFor(access: McpGrantAccess): string {
  return access === "write" ? `${MCP_SCOPES.read} ${MCP_SCOPES.write}` : MCP_SCOPES.read;
}

/** false for plain http and for hosts Anthropic's cloud cannot reach. */
export function reachableFromCloud(publicUrl: string): boolean {
  let u: URL;
  try {
    u = new URL(publicUrl);
  } catch {
    return false;
  }
  if (u.protocol !== "https:") return false;
  const h = u.hostname;
  if (LOOPBACK.has(h) || h.endsWith(".local") || h.endsWith(".internal") || !h.includes(".")) return false;
  return !/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|127\.)/.test(h);
}

export interface McpServiceDeps {
  store: McpStore;
  settings: SettingsStore;
  config: Pick<Config, "publicUrl" | "sessionSecret">;
  now?: () => Date;
}

export class McpService {
  private readonly store: McpStore;
  private readonly settings: SettingsStore;
  private readonly publicUrl: string;
  private readonly accessKey: Buffer;
  private readonly requestKey: Buffer;
  private readonly now: () => Date;

  constructor(deps: McpServiceDeps) {
    this.store = deps.store;
    this.settings = deps.settings;
    this.publicUrl = deps.config.publicUrl.replace(/\/+$/, "");
    const secret = Buffer.from(deps.config.sessionSecret, "utf8");
    this.accessKey = Buffer.from(hkdfSync("sha256", secret, Buffer.alloc(0), "bullpane:mcp:access:v1", 32));
    this.requestKey = Buffer.from(hkdfSync("sha256", secret, Buffer.alloc(0), "bullpane:mcp:consent:v1", 32));
    this.now = deps.now ?? (() => new Date());
  }

  get issuer(): string {
    return this.publicUrl;
  }

  get resource(): string {
    return `${this.publicUrl}/mcp`;
  }

  // -------------------------------------------------------------------------
  // Settings
  // -------------------------------------------------------------------------

  async getMaxAccess(): Promise<McpAccessLevel> {
    const raw = await this.settings.get(MCP_SETTINGS_KEY);
    return (MCP_ACCESS_LEVELS as readonly string[]).includes(raw ?? "") ? (raw as McpAccessLevel) : "off";
  }

  async setMaxAccess(level: McpAccessLevel): Promise<McpSettings> {
    await this.settings.set(MCP_SETTINGS_KEY, level);
    return this.getSettings();
  }

  async getSettings(): Promise<McpSettings> {
    return { maxAccess: await this.getMaxAccess(), endpoint: this.resource, reachableFromCloud: reachableFromCloud(this.publicUrl) };
  }

  // -------------------------------------------------------------------------
  // Registration (RFC 7591)
  // -------------------------------------------------------------------------

  async registerClient(body: unknown): Promise<Record<string, unknown>> {
    const meta = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
    const uris = meta.redirect_uris;
    if (!Array.isArray(uris) || uris.length === 0 || uris.length > 10 || !uris.every((u) => typeof u === "string")) {
      throw new OAuthError(400, "invalid_redirect_uri", "redirect_uris must be a non-empty array of at most 10 URIs");
    }
    const bad = (uris as string[]).find((u) => !isAllowedRedirectUri(u));
    if (bad) {
      throw new OAuthError(400, "invalid_redirect_uri", `Redirect URI not allowed: https, http on localhost, or an app scheme (got ${bad.slice(0, 200)})`);
    }
    const method = meta.token_endpoint_auth_method;
    if (method !== undefined && method !== "none") {
      throw new OAuthError(400, "invalid_client_metadata", "Only public clients are supported (token_endpoint_auth_method: none); PKCE protects the code");
    }
    const name = typeof meta.client_name === "string" && meta.client_name.trim() !== "" ? meta.client_name.trim().slice(0, 120) : "MCP client";

    const now = this.now();
    await this.store.purgeUnusedClients(new Date(now.getTime() - UNUSED_CLIENT_TTL_MS));
    if ((await this.store.countClients()) >= MAX_CLIENTS) {
      throw new OAuthError(503, "temporarily_unavailable", "Too many registered MCP clients; try again later");
    }

    const id = `bpc_${b64url(randomBytes(18))}`;
    await this.store.insertClient({ id, name, redirectUris: uris as string[], createdAt: now });
    return {
      client_id: id,
      client_id_issued_at: Math.floor(now.getTime() / 1000),
      client_name: name,
      redirect_uris: uris,
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    };
  }

  // -------------------------------------------------------------------------
  // Authorize → consent → code
  // -------------------------------------------------------------------------

  /**
   * Validates /oauth/authorize. Two kinds of failure, as RFC 6749 §4.1.2.1 says:
   * until the client and redirect URI are known good, the error is shown to the
   * user (`redirect: null`) — redirecting to an unverified URI is an open redirect.
   * After that, errors go back to the client.
   */
  async authorizeRequest(q: Record<string, string | undefined>): Promise<
    { ok: true; request: AuthorizeRequest } | { ok: false; redirect: string | null; error: OAuthError }
  > {
    const client = q.client_id ? await this.store.getClient(q.client_id) : null;
    if (!client) return { ok: false, redirect: null, error: new OAuthError(400, "invalid_client", "Unknown client_id. Remove the connector and add it again.") };
    const redirectUri = q.redirect_uri ?? (client.redirectUris.length === 1 ? client.redirectUris[0] : undefined);
    if (!redirectUri || !client.redirectUris.some((r) => redirectMatches(r, redirectUri))) {
      return { ok: false, redirect: null, error: new OAuthError(400, "invalid_request", "redirect_uri does not match the client's registration") };
    }

    const back = (error: OAuthError) => ({ ok: false as const, redirect: this.errorRedirect(redirectUri, error, q.state ?? null), error });
    if (q.response_type !== "code") return back(new OAuthError(400, "unsupported_response_type", "response_type must be code"));
    if (!q.code_challenge || q.code_challenge_method !== "S256") {
      return back(new OAuthError(400, "invalid_request", "PKCE is required: code_challenge with code_challenge_method=S256"));
    }
    if (!/^[A-Za-z0-9_-]{43,128}$/.test(q.code_challenge)) return back(new OAuthError(400, "invalid_request", "Malformed code_challenge"));
    if (q.resource !== undefined && !this.isOurResource(q.resource)) {
      return back(
        new OAuthError(400, "invalid_target", `This server is ${this.resource} (PUBLIC_URL); the client asked for ${q.resource.slice(0, 200)}`),
      );
    }
    return {
      ok: true,
      request: { clientId: client.id, redirectUri, codeChallenge: q.code_challenge, state: q.state ?? null, requested: parseScope(q.scope) },
    };
  }

  private isOurResource(resource: string): boolean {
    const r = resource.replace(/\/+$/, "");
    return r === this.resource || r === this.publicUrl;
  }

  errorRedirect(redirectUri: string, error: OAuthError, state: string | null): string {
    const u = new URL(redirectUri);
    u.searchParams.set("error", error.error);
    u.searchParams.set("error_description", error.message);
    if (state) u.searchParams.set("state", state);
    u.searchParams.set("iss", this.issuer);
    return u.toString();
  }

  /** The request travels through the browser to the consent page; the HMAC makes it tamper-proof. */
  signRequest(req: AuthorizeRequest): string {
    const body = b64url(Buffer.from(JSON.stringify({ ...req, exp: this.now().getTime() + REQUEST_TTL_MS })));
    return `${body}.${b64url(createHmac("sha256", this.requestKey).update(body).digest())}`;
  }

  verifyRequest(signed: string): AuthorizeRequest {
    const [body, sig] = signed.split(".");
    if (!body || !sig) throw new OAuthError(400, "invalid_request", "Malformed consent request");
    const expected = b64url(createHmac("sha256", this.requestKey).update(body).digest());
    if (!safeEqual(sig, expected)) throw new OAuthError(400, "invalid_request", "Consent request signature mismatch");
    const parsed = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as AuthorizeRequest & { exp: number };
    if (parsed.exp < this.now().getTime()) {
      throw new OAuthError(400, "invalid_request", "This sign-in request expired. Start the connection again from Claude.");
    }
    const { exp: _exp, ...req } = parsed;
    return req;
  }

  async consentInfo(signed: string, user: User): Promise<McpConsentInfo> {
    const req = this.verifyRequest(signed);
    const client = await this.store.getClient(req.clientId);
    if (!client) throw new OAuthError(400, "invalid_client", "This client is no longer registered. Add the connector again.");
    const maxAccess = await this.getMaxAccess();
    return {
      clientName: client.name,
      redirectHost: redirectHost(req.redirectUri),
      requested: req.requested ?? "write",
      maxAccess,
      allowed: mcpEffectiveAccess(maxAccess, "write", user.role),
    };
  }

  /**
   * The user's answer on the consent screen. Approving issues a code for
   * min(what they picked, what they are allowed); asking for more than allowed
   * is not an error, it is clamped — the screen never offers it anyway.
   */
  async decide(
    signed: string,
    user: User,
    approve: boolean,
    picked: McpGrantAccess,
  ): Promise<{ redirectTo: string; clientName: string; access: McpGrantAccess | null }> {
    const req = this.verifyRequest(signed);
    const client = await this.store.getClient(req.clientId);
    if (!client) throw new OAuthError(400, "invalid_client", "This client is no longer registered. Add the connector again.");
    const allowed = mcpEffectiveAccess(await this.getMaxAccess(), picked, user.role);
    if (!approve || allowed === "off") {
      const why = approve ? "MCP access is turned off on this Bullpane" : "The user declined the connection";
      return { redirectTo: this.errorRedirect(req.redirectUri, new OAuthError(403, "access_denied", why), req.state), clientName: client.name, access: null };
    }

    const code = random("bpac_");
    const now = this.now();
    await this.store.purgeExpiredCodes(now);
    await this.store.insertCode({
      codeHash: sha256(code),
      clientId: client.id,
      userId: user.id,
      access: allowed,
      redirectUri: req.redirectUri,
      codeChallenge: req.codeChallenge,
      expiresAt: new Date(now.getTime() + CODE_TTL_MS),
    });
    const u = new URL(req.redirectUri);
    u.searchParams.set("code", code);
    if (req.state) u.searchParams.set("state", req.state);
    // RFC 9207: tells the client which server answered (mix-up defence).
    u.searchParams.set("iss", this.issuer);
    return { redirectTo: u.toString(), clientName: client.name, access: allowed };
  }

  // -------------------------------------------------------------------------
  // Token endpoint
  // -------------------------------------------------------------------------

  async token(params: Record<string, string | undefined>): Promise<TokenResponse> {
    if (params.grant_type === "authorization_code") return this.exchangeCode(params);
    if (params.grant_type === "refresh_token") return this.refresh(params);
    throw new OAuthError(400, "unsupported_grant_type", "grant_type must be authorization_code or refresh_token");
  }

  private async exchangeCode(p: Record<string, string | undefined>): Promise<TokenResponse> {
    if (!p.code || !p.code_verifier || !p.client_id) {
      throw new OAuthError(400, "invalid_request", "code, code_verifier and client_id are required");
    }
    // Consumed BEFORE any check: a code that fails verification is burned, so it
    // cannot be retried with a guessed verifier.
    const row = await this.store.consumeCode(sha256(p.code));
    const now = this.now();
    if (!row || row.expiresAt < now) throw new OAuthError(400, "invalid_grant", "The authorization code is invalid, used or expired");
    if (row.clientId !== p.client_id) throw new OAuthError(400, "invalid_grant", "The code was issued to another client");
    if (p.redirect_uri !== undefined && p.redirect_uri !== row.redirectUri) {
      throw new OAuthError(400, "invalid_grant", "redirect_uri does not match the authorization request");
    }
    if (!/^[A-Za-z0-9._~-]{43,128}$/.test(p.code_verifier)) throw new OAuthError(400, "invalid_grant", "Malformed code_verifier");
    const challenge = b64url(createHash("sha256").update(p.code_verifier).digest());
    if (!safeEqual(challenge, row.codeChallenge)) throw new OAuthError(400, "invalid_grant", "PKCE verification failed");

    const refresh = random("bprt_");
    const grantId = nanoid();
    await this.store.insertGrant({
      id: grantId,
      clientId: row.clientId,
      userId: row.userId,
      access: row.access,
      refreshHash: sha256(refresh),
      prevRefreshHash: null,
      refreshExpiresAt: new Date(now.getTime() + REFRESH_TTL_MS),
      createdAt: now,
      lastUsedAt: null,
    });
    return this.tokenResponse(grantId, refresh, row.access);
  }

  private async refresh(p: Record<string, string | undefined>): Promise<TokenResponse> {
    if (!p.refresh_token || !p.client_id) throw new OAuthError(400, "invalid_request", "refresh_token and client_id are required");
    const hash = sha256(p.refresh_token);
    const grant = await this.store.findGrantByRefresh(hash);
    if (!grant) {
      // A refresh token that was already rotated away is being replayed: either
      // the client is buggy or the token leaked. Either way, end the whole grant.
      const replayed = await this.store.findGrantByPrevRefresh(hash);
      if (replayed) await this.store.deleteGrant(replayed.id);
      throw new OAuthError(400, "invalid_grant", "The refresh token is invalid or was already used");
    }
    const now = this.now();
    if (grant.clientId !== p.client_id) throw new OAuthError(400, "invalid_grant", "The refresh token was issued to another client");
    if (grant.refreshExpiresAt < now) {
      await this.store.deleteGrant(grant.id);
      throw new OAuthError(400, "invalid_grant", "The refresh token expired; connect again");
    }
    const full = await this.store.getGrantWithUser(grant.id);
    if (!full || full.user.disabledAt) throw new OAuthError(400, "invalid_grant", "This account is disabled");

    const next = random("bprt_");
    const rotated = await this.store.rotateRefresh(grant.id, hash, sha256(next), new Date(now.getTime() + REFRESH_TTL_MS));
    if (!rotated) throw new OAuthError(400, "invalid_grant", "The refresh token was already used");
    return this.tokenResponse(grant.id, next, grant.access);
  }

  private tokenResponse(grantId: string, refresh: string, access: McpGrantAccess): TokenResponse {
    return { access_token: this.signAccess(grantId), token_type: "Bearer", expires_in: ACCESS_TTL_S, refresh_token: refresh, scope: scopeFor(access) };
  }

  /** RFC 7009. Always succeeds from the client's point of view. */
  async revokeToken(token: string | undefined): Promise<void> {
    if (!token) return;
    const grantId = token.startsWith("bpat.") ? this.verifyAccess(token) : (await this.store.findGrantByRefresh(sha256(token)))?.id;
    if (grantId) await this.store.deleteGrant(grantId);
  }

  // -------------------------------------------------------------------------
  // Access tokens and the per-call check
  // -------------------------------------------------------------------------

  signAccess(grantId: string): string {
    const body = b64url(Buffer.from(JSON.stringify({ g: grantId, e: Math.floor(this.now().getTime() / 1000) + ACCESS_TTL_S })));
    return `bpat.${body}.${b64url(createHmac("sha256", this.accessKey).update(body).digest())}`;
  }

  /** grant id of a valid, unexpired access token; null otherwise. */
  verifyAccess(token: string): string | null {
    const [prefix, body, sig] = token.split(".");
    if (prefix !== "bpat" || !body || !sig) return null;
    const expected = b64url(createHmac("sha256", this.accessKey).update(body).digest());
    if (!safeEqual(sig, expected)) return null;
    try {
      const { g, e } = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as { g?: unknown; e?: unknown };
      if (typeof g !== "string" || typeof e !== "number" || e * 1000 < this.now().getTime()) return null;
      return g;
    } catch {
      return null;
    }
  }

  /**
   * Resolves `Authorization: Bearer` into who is calling and what they may do
   * NOW. null = the token is not usable (401). Access `off` is a valid caller
   * with nothing allowed: the endpoint answers 403 with the reason.
   */
  async authenticate(token: string): Promise<McpCaller | null> {
    const grantId = this.verifyAccess(token);
    if (!grantId) return null;
    const full = await this.store.getGrantWithUser(grantId);
    if (!full || full.user.disabledAt) return null;
    const now = this.now();
    if (!full.grant.lastUsedAt || now.getTime() - full.grant.lastUsedAt.getTime() > TOUCH_EVERY_MS) {
      await this.store.touchGrant(grantId, now);
    }
    const user = toUserDto(full.user);
    return {
      user,
      grantId,
      clientName: full.clientName,
      access: mcpEffectiveAccess(await this.getMaxAccess(), full.grant.access, user.role),
    };
  }

  // -------------------------------------------------------------------------
  // Settings → MCP: connected clients
  // -------------------------------------------------------------------------

  async listGrants(viewer: User, all: boolean): Promise<McpGrant[]> {
    const rows = await this.store.listGrants(all && viewer.role === "admin" ? null : viewer.id);
    return rows.map(toGrantDto);
  }

  /** Disabling a user or changing their password ends every client they connected, like their sessions. */
  async revokeAllForUser(userId: string): Promise<void> {
    await this.store.deleteGrantsForUser(userId);
  }

  /** Own grants for anyone; any grant for an admin. Returns the revoked grant for the audit row. */
  async revokeGrant(id: string, actor: User): Promise<McpGrant | null> {
    const full = await this.store.getGrantWithUser(id);
    if (!full || (full.grant.userId !== actor.id && actor.role !== "admin")) return null;
    await this.store.deleteGrant(id);
    return toGrantDto(full);
  }
}

function toGrantDto(r: McpGrantWithUser): McpGrant {
  return {
    id: r.grant.id,
    clientName: r.clientName,
    redirectHost: redirectHost(r.redirectUris[0] ?? ""),
    access: r.grant.access,
    userId: r.user.id,
    userEmail: r.user.email,
    userName: r.user.name,
    createdAt: r.grant.createdAt.toISOString(),
    lastUsedAt: r.grant.lastUsedAt ? r.grant.lastUsedAt.toISOString() : null,
  };
}
