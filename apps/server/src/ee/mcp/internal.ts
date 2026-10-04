/**
 * How an MCP tool becomes an /api call made AS the user who connected the client.
 *
 * This is the "one rule for the MCP and the dashboard" decision in code. A tool
 * does not reach into the inspector; it calls the same /api route the dashboard
 * calls, through `app.inject`, so role guards, zod validation, Pro gates,
 * BULLPANE_READ_ONLY, demo mode and the audit hook all apply without the MCP
 * knowing they exist. A route added later is safe from the MCP by construction.
 *
 * The identity is handed over in memory, not as a token on the request: the
 * injected request carries `x-bullpane-mcp-call: <nonce>.<id>`, where the nonce
 * is random per process (an injected request never leaves it) and the id names
 * an entry that lives only for the duration of that call. The MCP bearer token
 * itself is never accepted by /api — it works at /mcp and nowhere else.
 *
 * The user is handed over with their role CAPPED to what the MCP access allows:
 * `read` acts as a viewer, `write` as at most an operator. So drain and
 * obliterate (admin routes) answer 403 even for an admin, and the tools for them
 * only return a dashboard link.
 */
import { randomBytes, timingSafeEqual } from "node:crypto";
import { hasRole, type McpAccessLevel, type Role, type User } from "@bullpane/shared";

export const MCP_CALL_HEADER = "x-bullpane-mcp-call";

export interface McpCallIdentity {
  user: User;
  clientName: string;
  grantId: string;
}

/** The role an MCP call acts with. null for `off`: no call is made at all. */
export function cappedRole(role: Role, access: McpAccessLevel): Role | null {
  if (access === "off") return null;
  if (access === "read") return "viewer";
  return hasRole(role, "operator") ? "operator" : role;
}

export class McpCallBridge {
  private readonly nonce = randomBytes(32).toString("base64url");
  private readonly pending = new Map<string, McpCallIdentity>();

  /** Registers the identity for one call; `release` must run when the call ends. */
  open(identity: McpCallIdentity): { header: string; release: () => void } {
    const id = randomBytes(16).toString("base64url");
    this.pending.set(id, identity);
    return { header: `${this.nonce}.${id}`, release: () => this.pending.delete(id) };
  }

  /** The identity behind an injected request's header, or null for anything else. */
  resolve(raw: string | string[] | undefined): McpCallIdentity | null {
    if (typeof raw !== "string") return null;
    const dot = raw.indexOf(".");
    if (dot <= 0) return null;
    const nonce = Buffer.from(raw.slice(0, dot));
    const expected = Buffer.from(this.nonce);
    if (nonce.length !== expected.length || !timingSafeEqual(nonce, expected)) return null;
    return this.pending.get(raw.slice(dot + 1)) ?? null;
  }
}
