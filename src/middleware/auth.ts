import type { FastifyRequest, FastifyReply } from "fastify";
import { bearerToken } from "../plugins/authProvider.js";

// User data attached to request after authentication
export interface AuthUser {
  id: number; // Local database ID
  clerkId: string; // Clerk user ID
  username: string;
}

declare module "fastify" {
  interface FastifyRequest {
    user?: AuthUser;
    clerkId?: string;
  }
}

/**
 * Requires a Clerk session (Authorization: Bearer <token>) and a local
 * profile. Attaches request.user.
 */
export async function authMiddleware(request: FastifyRequest, reply: FastifyReply) {
  const token = bearerToken(request);
  const clerkId = token ? await request.server.authProvider.verifyToken(token) : null;
  if (!clerkId) {
    return reply.status(401).send({ error: "Authentication required", code: "AUTH_REQUIRED" });
  }

  const { rows } = await request.server.pg.query<{ id: number; username: string }>(
    `SELECT id, username FROM users WHERE "clerkId" = $1`,
    [clerkId]
  );
  const user = rows[0];
  if (!user) {
    // Signed in with Clerk but hasn't completed profile setup
    return reply.status(403).send({
      error: "Profile setup required",
      code: "PROFILE_SETUP_REQUIRED",
    });
  }

  request.clerkId = clerkId;
  request.user = { id: user.id, clerkId, username: user.username };
}

/**
 * Requires a Clerk session only, for routes used before the local profile
 * exists (profile setup). Attaches request.clerkId.
 */
export async function clerkAuthMiddleware(request: FastifyRequest, reply: FastifyReply) {
  const token = bearerToken(request);
  const clerkId = token ? await request.server.authProvider.verifyToken(token) : null;
  if (!clerkId) {
    return reply.status(401).send({ error: "Authentication required", code: "AUTH_REQUIRED" });
  }
  request.clerkId = clerkId;
}
