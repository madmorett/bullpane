import { hasRole, type Role } from "@bullmq-visualizer/shared";
import type { FastifyReply, FastifyRequest } from "fastify";
import { forbidden, unauthenticated } from "../plugins/errors";

export async function requireAuth(request: FastifyRequest, _reply?: FastifyReply): Promise<void> {
  if (!request.user) throw unauthenticated();
}

export function requireRole(role: Role) {
  return async function roleGuard(request: FastifyRequest, _reply?: FastifyReply): Promise<void> {
    if (!request.user) throw unauthenticated();
    if (!hasRole(request.user.role, role)) throw forbidden(`This action requires the ${role} role`);
  };
}
