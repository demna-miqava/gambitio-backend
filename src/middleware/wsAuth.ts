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

/** Subprotocol the frontend offers, and the server agrees to, on every socket. */
export const WS_PROTOCOL = "gambitio";
/** Prefix of the subprotocol entry that carries the Clerk session token. */
export const WS_TOKEN_PREFIX = "auth.";

/**
 * The session token from the WebSocket handshake. Browsers can't set headers
 * on a WebSocket, but they can list subprotocols, so the client offers
 * ["gambitio", "auth.<token>"] (a JWT only uses characters a subprotocol
 * may contain). Unlike a ?token= query, this never appears in a URL, so it
 * isn't written to request logs (ours or the edge's).
 */
export function wsHandshakeToken(headers: Record<string, string | string[] | undefined>): string | null {
  const raw = headers["sec-websocket-protocol"];
  const value = Array.isArray(raw) ? raw.join(",") : raw;
  if (!value) return null;
  for (const entry of value.split(",")) {
    const protocol = entry.trim();
    if (protocol.startsWith(WS_TOKEN_PREFIX)) return protocol.slice(WS_TOKEN_PREFIX.length) || null;
  }
  return null;
}

/** Chooses the subprotocol answered to the browser (it must be one it offered, never the token). */
export function selectWsProtocol(protocols: Set<string>): string | false {
  return protocols.has(WS_PROTOCOL) ? WS_PROTOCOL : false;
}

/**
 * preValidation hook for WebSocket routes. Runs before the HTTP upgrade, so
 * a missing or bad token gets a plain 401 and no socket is ever opened.
 * The Clerk session token comes in the subprotocol list (wsHandshakeToken).
 * Once open, the socket must keep proving the session is alive: see
 * keepAuthenticated in realtime/socket.ts.
 */
export async function wsAuthHook(request: FastifyRequest, reply: FastifyReply) {
  const token = wsHandshakeToken(request.headers);
  const clerkId = token ? await request.server.authProvider.verifyToken(token) : null;
  if (!clerkId) {
    return reply.status(401).send({ error: "Invalid or expired token", code: "INVALID_TOKEN" });
  }

  const user = await request.server.users.byClerkId(clerkId);
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
