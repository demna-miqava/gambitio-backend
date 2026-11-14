import type { FastifyRequest } from "fastify";
import { createClerkClient, verifyToken } from "@clerk/backend";

/**
 * How requests are authenticated. The default verifies Clerk session tokens;
 * tests inject a fake so they never call Clerk.
 */
export interface AuthProvider {
  /** Clerk user id for a session token, or null if it's invalid. */
  verifyToken(token: string): Promise<string | null>;
  /** Primary email of a Clerk user, used when creating the profile. */
  getEmail(clerkId: string): Promise<string | null>;
  /** Deletes the Clerk user (account deletion). Must succeed if already gone. */
  deleteUser(clerkId: string): Promise<void>;
}

declare module "fastify" {
  interface FastifyInstance {
    authProvider: AuthProvider;
  }
}

/** Token from `Authorization: Bearer <token>`. */
export function bearerToken(request: FastifyRequest): string | null {
  const header = request.headers.authorization;
  return header?.startsWith("Bearer ") ? header.slice(7) || null : null;
}

/**
 * Verifies Clerk session tokens (REST bearer tokens and WebSocket tokens
 * alike). `isAuthorizedParty` rejects tokens minted for other origins: like
 * Clerk's own `authorizedParties` option, it checks the `azp` claim when the
 * token has one, but can match origins by rule rather than from a fixed list.
 */
export function clerkAuthProvider(
  secretKey: string,
  isAuthorizedParty: (origin: string) => boolean
): AuthProvider {
  const clerk = createClerkClient({ secretKey });
  return {
    verifyToken: async (token) => {
      try {
        const payload = await verifyToken(token, { secretKey });
        if (typeof payload.azp === "string" && !isAuthorizedParty(payload.azp)) return null;
        return payload.sub ?? null;
      } catch {
        return null;
      }
    },
    getEmail: async (clerkId) => {
      const user = await clerk.users.getUser(clerkId);
      return (
        user.emailAddresses.find((e) => e.id === user.primaryEmailAddressId)?.emailAddress ?? null
      );
    },
    deleteUser: async (clerkId) => {
      try {
        await clerk.users.deleteUser(clerkId);
      } catch (error) {
        // Already deleted (a retry after a partial failure) counts as done
        if ((error as { status?: number }).status === 404) return;
        throw error;
      }
    },
  };
}
