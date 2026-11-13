import type { FastifyReply, FastifyRequest } from "fastify";

export interface WsAuthResult {
  id: number;
  clerkId: string;
  username: string;
  avatarUrl: string | null;
}

declare module "fastify" {
  interface FastifyRequest {
    wsUser?: WsAuthResult;
  }
}

/** Open sockets one user may hold on one server instance (tabs × socket types). */
export const MAX_SOCKETS_PER_USER = 12;

/**
 * preValidation hook for WebSocket routes. Runs before the HTTP upgrade, so
 * a missing or bad token gets a plain 401 and no socket is ever opened.
 * The Clerk session token comes as ?token=<token> (browsers can't set
 * headers on WebSocket requests); it's redacted from request logs in app.ts.
 */
export async function wsAuthHook(request: FastifyRequest, reply: FastifyReply) {
  const token = (request.query as { token?: string }).token;
  const clerkId = token ? await request.server.authProvider.verifyToken(token) : null;
  if (!clerkId) {
    return reply.status(401).send({ error: "Invalid or expired token", code: "INVALID_TOKEN" });
  }

  const { rows } = await request.server.pg.query<{
    id: number;
    username: string;
    avatarUrl: string | null;
  }>(`SELECT id, username, "avatarUrl" FROM users WHERE "clerkId" = $1`, [clerkId]);
  const user = rows[0];
  if (!user) {
    return reply
      .status(403)
      .send({ error: "Profile setup required", code: "PROFILE_SETUP_REQUIRED" });
  }

  if (request.server.hub.userSocketCount(user.id) >= MAX_SOCKETS_PER_USER) {
    return reply.status(429).send({ error: "Too many open connections", code: "TOO_MANY_SOCKETS" });
  }

  request.wsUser = { ...user, clerkId };
}
