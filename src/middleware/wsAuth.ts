import type { FastifyRequest } from "fastify";
import type { WebSocket } from "ws";
import { verifyToken, type DecodedToken } from "../utils/jwtHelpers.js";

export interface AuthenticatedWebSocket extends WebSocket {
  userId: number;
  username: string;
}

export interface WebSocketErrorMessage {
  type: "error";
  data: {
    message: string;
  };
}

/**
 * Authenticate WebSocket connection via cookie
 * Returns decoded token or null if authentication fails
 */
export async function authenticateWebSocket(
  request: FastifyRequest,
  socket: WebSocket
): Promise<DecodedToken | null> {
  try {
    const accessToken = request.cookies.accessToken;
    if (!accessToken) {
      const errorMsg: WebSocketErrorMessage = {
        type: "error",
        data: { message: "Authentication required" },
      };
      socket.send(JSON.stringify(errorMsg));
      socket.close();
      return null;
    }

    const decoded = verifyToken(accessToken);
    return decoded;
  } catch (error) {
    const errorMsg: WebSocketErrorMessage = {
      type: "error",
      data: { message: "Authentication failed" },
    };
    socket.send(JSON.stringify(errorMsg));
    socket.close();
    return null;
  }
}
