import type { FastifyRequest, FastifyReply } from "fastify";
import { getAuth } from "@clerk/fastify";

// User data attached to request after authentication
export interface AuthUser {
  id: number; // Local database ID
  clerkId: string; // Clerk user ID
  username: string;
}

// Extend FastifyRequest to include user property
declare module "fastify" {
  interface FastifyRequest {
    user?: AuthUser;
  }
}

/**
 * Authentication middleware using Clerk
 * - Verifies Clerk session
 * - Looks up local user by Clerk ID
 * - Attaches user data to request
 */
export async function authMiddleware(
  request: FastifyRequest,
  reply: FastifyReply
) {
  try {
    const { userId: clerkId } = getAuth(request);

    if (!clerkId) {
      return reply.status(401).send({ error: "Authentication required" });
    }

    // Look up local user by Clerk ID
    const client = await request.server.pg.connect();
    try {
      const { rows } = await client.query<{ id: number; username: string }>(
        `SELECT id, username FROM users WHERE "clerkId" = $1`,
        [clerkId]
      );

      if (rows.length === 0) {
        // User authenticated with Clerk but not yet synced to local DB
        // This happens when user signs up via Clerk but hasn't completed profile setup
        return reply.status(403).send({
          error: "Profile setup required",
          code: "PROFILE_SETUP_REQUIRED",
        });
      }

      request.user = {
        id: rows[0].id,
        clerkId,
        username: rows[0].username,
      };
    } finally {
      client.release();
    }
  } catch (error) {
    request.server.log.error(error);
    return reply.status(401).send({ error: "Authentication failed" });
  }
}

/**
 * Lightweight auth middleware that only checks Clerk session
 * Use this for routes that don't need local user data (e.g., profile setup)
 */
export async function clerkAuthMiddleware(
  request: FastifyRequest,
  reply: FastifyReply
) {
  try {
    const { userId: clerkId } = getAuth(request);

    if (!clerkId) {
      return reply.status(401).send({ error: "Authentication required" });
    }

    // Attach just the Clerk ID for routes that need it
    request.user = {
      id: 0, // Not known yet
      clerkId,
      username: "", // Not known yet
    };
  } catch (error) {
    request.server.log.error(error);
    return reply.status(401).send({ error: "Authentication failed" });
  }
}
