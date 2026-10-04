/**
 * The MCP endpoint and the OAuth routes around it. Registered at the ROOT, not
 * under /api: MCP clients look for `/.well-known/*` at the origin and for the
 * endpoint at the URL the user pasted, and none of these use the session cookie
 * (/api's authPlugin is the wrong tool for them).
 *
 *   GET  /.well-known/oauth-protected-resource[/mcp]  RFC 9728
 *   GET  /.well-known/oauth-authorization-server      RFC 8414
 *   POST /oauth/register                              RFC 7591
 *   GET  /oauth/authorize   → the consent page in the SPA (/oauth/consent)
 *   POST /oauth/token                                 code + PKCE, refresh
 *   POST /oauth/revoke                                RFC 7009
 *   POST /mcp               JSON-RPC, Streamable HTTP, stateless, JSON responses
 *
 * Stateless on purpose: no SSE stream and no Mcp-Session-Id, so any replica can
 * answer any request and nothing lives in memory between calls.
 */
import { mapError } from "../../plugins/errors";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { cappedRole, MCP_CALL_HEADER } from "./internal";
import { MCP_SCOPES, OAuthError, type McpCaller } from "./service";
import { toolsFor, type ApiCall } from "./tools";

export const MCP_PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26"] as const;

const SERVER_INSTRUCTIONS =
  "Bullpane is a dashboard for BullMQ queues stored in Redis. Start with list_connections, then list_queues. " +
  "Every action runs as the Bullpane user who connected this client and is recorded in Bullpane's audit log. " +
  "Draining, cleaning or obliterating a queue is never done from here: request_destructive_action returns a dashboard link for the user to confirm.";

function sendOAuthError(reply: FastifyReply, err: unknown): FastifyReply {
  if (err instanceof OAuthError) return reply.status(err.status).header("cache-control", "no-store").send(err.toBody());
  throw err;
}

/** application/x-www-form-urlencoded or JSON, whichever the client sent. */
function formBody(body: unknown): Record<string, string | undefined> {
  if (typeof body === "string") return Object.fromEntries(new URLSearchParams(body));
  if (typeof body === "object" && body !== null) {
    return Object.fromEntries(Object.entries(body).map(([k, v]) => [k, typeof v === "string" ? v : undefined]));
  }
  return {};
}

interface JsonRpcRequest {
  jsonrpc?: unknown;
  id?: string | number | null;
  method?: unknown;
  params?: Record<string, unknown>;
}

const rpcResult = (id: JsonRpcRequest["id"], result: unknown) => ({ jsonrpc: "2.0", id, result });
const rpcError = (id: JsonRpcRequest["id"], code: number, message: string) => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });

export async function mcpRootRoutes(app: FastifyInstance): Promise<void> {
  const mcp = app.ctx.mcp;

  // Token and revoke are form-encoded (RFC 6749). Only in this plugin's scope.
  app.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "string" }, (_req, body, done) => done(null, body));

  const resourceMetadataUrl = `${mcp.issuer}/.well-known/oauth-protected-resource`;
  const protectedResource = async () => ({
    resource: mcp.resource,
    authorization_servers: [mcp.issuer],
    scopes_supported: [MCP_SCOPES.read, MCP_SCOPES.write],
    bearer_methods_supported: ["header"],
    resource_name: "Bullpane",
  });
  app.get("/.well-known/oauth-protected-resource", protectedResource);
  app.get("/.well-known/oauth-protected-resource/mcp", protectedResource);

  app.get("/.well-known/oauth-authorization-server", async () => ({
    issuer: mcp.issuer,
    authorization_endpoint: `${mcp.issuer}/oauth/authorize`,
    token_endpoint: `${mcp.issuer}/oauth/token`,
    registration_endpoint: `${mcp.issuer}/oauth/register`,
    revocation_endpoint: `${mcp.issuer}/oauth/revoke`,
    scopes_supported: [MCP_SCOPES.read, MCP_SCOPES.write],
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    revocation_endpoint_auth_methods_supported: ["none"],
    authorization_response_iss_parameter_supported: true,
  }));

  /** MCP is Pro: without it, registration and sign-in say so instead of half-working. */
  const assertPro = () => {
    if (!app.ctx.edition.getEdition().features.mcp) {
      throw new OAuthError(403, "access_denied", "MCP is a Bullpane Pro feature. Unlock Pro in Settings → License.");
    }
  };

  app.post("/oauth/register", async (request, reply) => {
    try {
      assertPro();
      const client = await mcp.registerClient(request.body);
      return reply.status(201).header("cache-control", "no-store").send(client);
    } catch (err) {
      return sendOAuthError(reply, err);
    }
  });

  app.get<{ Querystring: Record<string, string | undefined> }>("/oauth/authorize", async (request, reply) => {
    // Errors the user must read (unknown client, bad redirect) land on the SPA's
    // consent page, which renders `error`. Never on an unverified redirect URI.
    const showError = (message: string) => reply.redirect(`/oauth/consent?error=${encodeURIComponent(message)}`, 302);
    if (!app.ctx.edition.getEdition().features.mcp) {
      return showError("MCP is a Bullpane Pro feature. Ask an admin to unlock Pro in Settings → License.");
    }
    const result = await mcp.authorizeRequest(request.query);
    if (!result.ok) return result.redirect ? reply.redirect(result.redirect, 302) : showError(result.error.message);
    return reply.redirect(`/oauth/consent?request=${encodeURIComponent(mcp.signRequest(result.request))}`, 302);
  });

  app.post("/oauth/token", async (request, reply) => {
    try {
      assertPro();
      const tokens = await mcp.token(formBody(request.body));
      return reply.header("cache-control", "no-store").header("pragma", "no-cache").send(tokens);
    } catch (err) {
      return sendOAuthError(reply, err);
    }
  });

  app.post("/oauth/revoke", async (request, reply) => {
    await mcp.revokeToken(formBody(request.body).token);
    return reply.status(200).send({});
  });

  // -------------------------------------------------------------------------
  // POST /mcp
  // -------------------------------------------------------------------------

  const unauthorized = (reply: FastifyReply, description: string) =>
    reply
      .status(401)
      .header("www-authenticate", `Bearer resource_metadata="${resourceMetadataUrl}", error="invalid_token", error_description="${description}"`)
      .send({ error: "invalid_token", error_description: description });

  /**
   * One /api call as the caller, through the bridge (internal.ts). The client's
   * IP and user agent ride along, so the audit row names where the call came
   * from and not the in-process inject.
   */
  const apiCall = (caller: McpCaller, role: NonNullable<ReturnType<typeof cappedRole>>, origin: FastifyRequest) => async (req: ApiCall) => {
    const { header, release } = app.ctx.mcpCalls.open({
      user: { ...caller.user, role },
      clientName: caller.clientName,
      grantId: caller.grantId,
    });
    try {
      const res = await app.inject({
        method: req.method,
        url: req.url,
        headers: {
          [MCP_CALL_HEADER]: header,
          "x-forwarded-for": origin.ip,
          ...(typeof origin.headers["user-agent"] === "string" ? { "user-agent": origin.headers["user-agent"] } : {}),
          ...(req.body !== undefined ? { "content-type": "application/json" } : {}),
        },
        ...(req.body !== undefined ? { payload: JSON.stringify(req.body) } : {}),
      });
      let body: unknown = res.body;
      try {
        body = res.body ? JSON.parse(res.body) : null;
      } catch {
        // not JSON: keep the text
      }
      return { status: res.statusCode, body };
    } finally {
      release();
    }
  };

  /** Why this connection can do nothing right now, or null when it can. */
  const blockedReason = (caller: McpCaller): string | null => {
    if (!app.ctx.edition.getEdition().features.mcp) return "MCP is a Bullpane Pro feature and this install has no active Pro license.";
    if (caller.access === "off") return "MCP access is turned off on this Bullpane (Settings → MCP). Ask an admin to enable it.";
    return null;
  };

  const handle = async (caller: McpCaller, msg: JsonRpcRequest, origin: FastifyRequest) => {
    const id = msg.id;
    switch (msg.method) {
      case "initialize": {
        const asked = typeof msg.params?.protocolVersion === "string" ? msg.params.protocolVersion : "";
        const protocolVersion = (MCP_PROTOCOL_VERSIONS as readonly string[]).includes(asked) ? asked : MCP_PROTOCOL_VERSIONS[1];
        const blocked = blockedReason(caller);
        return rpcResult(id, {
          protocolVersion,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "bullpane", title: "Bullpane", version: app.ctx.version },
          instructions: blocked ? `${SERVER_INSTRUCTIONS}\n\nRight now: ${blocked}` : `${SERVER_INSTRUCTIONS}\n\nThis connection has ${caller.access} access as ${caller.user.email}.`,
        });
      }
      case "ping":
        return rpcResult(id, {});
      case "tools/list": {
        const tools = blockedReason(caller) ? [] : toolsFor(caller.access);
        return rpcResult(id, {
          tools: tools.map((t) => ({ name: t.name, title: t.title, description: t.description, inputSchema: t.inputSchema, annotations: t.annotations })),
        });
      }
      case "tools/call": {
        const name = typeof msg.params?.name === "string" ? msg.params.name : "";
        const blocked = blockedReason(caller);
        if (blocked) return rpcResult(id, { content: [{ type: "text", text: blocked }], isError: true });
        const t = toolsFor("write").find((x) => x.name === name);
        if (!t) return rpcError(id, -32602, `Unknown tool: ${name}`);
        if (!toolsFor(caller.access).includes(t)) {
          return rpcResult(id, {
            content: [{ type: "text", text: `${name} needs write access; this connection has ${caller.access} access (the lowest of the admin's MCP setting, what was approved and the user's role).` }],
            isError: true,
          });
        }
        const role = cappedRole(caller.user.role, caller.access);
        if (!role) return rpcResult(id, { content: [{ type: "text", text: "MCP access is off." }], isError: true });
        return rpcResult(id, await t.run(msg.params?.arguments, { publicUrl: mcp.issuer, call: apiCall(caller, role, origin) }));
      }
      default:
        return rpcError(id, -32601, `Method not found: ${String(msg.method)}`);
    }
  };

  app.post("/mcp", async (request: FastifyRequest, reply) => {
    const auth = request.headers.authorization;
    const token = typeof auth === "string" && /^Bearer\s+/i.test(auth) ? auth.replace(/^Bearer\s+/i, "").trim() : null;
    if (!token) return unauthorized(reply, "Missing bearer token");
    const caller = await mcp.authenticate(token);
    if (!caller) return unauthorized(reply, "The access token is invalid, expired or revoked");

    const msg = request.body as JsonRpcRequest | JsonRpcRequest[] | undefined;
    if (Array.isArray(msg)) return reply.send(rpcError(null, -32600, "JSON-RPC batches are not supported"));
    if (!msg || typeof msg !== "object" || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") {
      return reply.send(rpcError(null, -32600, "Invalid JSON-RPC request"));
    }
    // A notification (no id) gets no response body (Streamable HTTP: 202).
    if (msg.id === undefined) return reply.status(202).send();
    try {
      return reply.send(await handle(caller, msg, request));
    } catch (err) {
      const mapped = mapError(err);
      if (mapped.unexpected) request.log.error({ err }, "mcp call failed");
      return reply.send(rpcError(msg.id, -32603, mapped.body.message));
    }
  });

  // No server-initiated stream and no sessions to delete (see the header).
  const notAllowed = async (_request: FastifyRequest, reply: FastifyReply) => reply.status(405).header("allow", "POST").send();
  app.get("/mcp", notAllowed);
  app.delete("/mcp", notAllowed);
}
