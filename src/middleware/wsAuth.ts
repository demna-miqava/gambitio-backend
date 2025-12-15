import type { FastifyRequest } from "fastify";
import type { WebSocket } from "ws";
import { verifyToken } from "@clerk/backend";

export interface AuthenticatedWebSocket extends WebSocket {
  userId: number;    // Local database ID
  clerkId: string;   // Clerk user ID
  username: string;
}

export interface WebSocketErrorMessage {
  type: "error";
  data: {
    message: string;
    code?: string;
  };
}

export interface WsAuthResult {
  id: number;
  clerkId: string;
  username: string;
}

/**
 * Authenticate WebSocket connection using Clerk token
 * Token should be passed as query parameter: ?token=<clerk_session_token>
 * Returns local user data or null if authentication fails
 */
export async function authenticateWebSocket(
  request: FastifyRequest,
  socket: WebSocket
): Promise<WsAuthResult | null> {
  try {
    // Get token from query parameter
    const token = (request.query as { token?: string }).token;

    if (!token) {
      const errorMsg: WebSocketErrorMessage = {
        type: "error",
        data: { message: "Authentication required", code: "AUTH_REQUIRED" },
      };
      socket.send(JSON.stringify(errorMsg));
      socket.close();
      return null;
    }

    // Verify token with Clerk
    const secretKey = process.env.CLERK_SECRET_KEY;
    if (!secretKey) {
      request.server.log.error("CLERK_SECRET_KEY not configured");
      const errorMsg: WebSocketErrorMessage = {
        type: "error",
        data: { message: "Server configuration error" },
      };
      socket.send(JSON.stringify(errorMsg));
      socket.close();
      return null;
    }

    let clerkId: string;
    try {
      const payload = await verifyToken(token, { secretKey });
      clerkId = payload.sub;
    } catch (err) {
      const errorMsg: WebSocketErrorMessage = {
        type: "error",
        data: { message: "Invalid or expired token", code: "INVALID_TOKEN" },
      };
      socket.send(JSON.stringify(errorMsg));
      socket.close();
      return null;
    }

    // Look up local user by Clerk ID
    const client = await request.server.pg.connect();
    try {
      const { rows } = await client.query<{ id: number; username: string }>(
        `SELECT id, username FROM users WHERE "clerkId" = $1`,
        [clerkId]
      );

      if (rows.length === 0) {
        const errorMsg: WebSocketErrorMessage = {
          type: "error",
          data: { message: "Profile setup required", code: "PROFILE_SETUP_REQUIRED" },
        };
        socket.send(JSON.stringify(errorMsg));
        socket.close();
        return null;
      }

      return {
        id: rows[0].id,
        clerkId,
        username: rows[0].username,
      };
    } finally {
      client.release();
    }
  } catch (error) {
    request.server.log.error(error);
    const errorMsg: WebSocketErrorMessage = {
      type: "error",
      data: { message: "Authentication failed" },
    };
    socket.send(JSON.stringify(errorMsg));
    socket.close();
    return null;
  }
}
