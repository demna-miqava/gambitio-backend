import type { FastifyInstance } from "fastify";
import { authenticateWebSocket } from "../../middleware/wsAuth.js";
import { MatchmakingHandler } from "../../handlers/matchmakingHandler.js";
import { matchmakingConnectionManager } from "../../utils/wsConnectionManager.js";
import type { MatchmakingMessage } from "../../models/Matchmaking.js";

export async function matchmakingWebSocketRoute(fastify: FastifyInstance) {
  const matchmakingHandler = new MatchmakingHandler(fastify);

  fastify.get<{
    Querystring: { time?: string; increment?: string };
  }>("/matchmaking", { websocket: true }, async (socket, request) => {
    // Authenticate user
    const decoded = await authenticateWebSocket(request, socket);
    if (!decoded) return;

    const userId = decoded.userId;
    const username = decoded.username;

    // Parse query parameters
    const timeParam = request.query.time;
    const incrementParam = request.query.increment;

    if (!timeParam) {
      const errorMsg: MatchmakingMessage = {
        type: "error",
        data: { message: "Time parameter is required" },
      };
      socket.send(JSON.stringify(errorMsg));
      socket.close();
      return;
    }

    const time = parseInt(timeParam, 10);
    const increment = incrementParam ? parseInt(incrementParam, 10) : null;

    if (isNaN(time) || time <= 0) {
      const errorMsg: MatchmakingMessage = {
        type: "error",
        data: { message: "Invalid time parameter" },
      };
      socket.send(JSON.stringify(errorMsg));
      socket.close();
      return;
    }

    if (incrementParam !== undefined && (isNaN(increment!) || increment! < 0)) {
      const errorMsg: MatchmakingMessage = {
        type: "error",
        data: { message: "Invalid increment parameter" },
      };
      socket.send(JSON.stringify(errorMsg));
      socket.close();
      return;
    }

    // Fetch user ratings and avatar
    let userRating: { bullet: number; blitz: number; rapid: number };
    let avatarUrl: string;

    const client = await fastify.pg.connect();
    try {
      const { rows } = await client.query(
        `SELECT "bulletRating", "blitzRating", "rapidRating", "avatarUrl"
         FROM users WHERE id = $1`,
        [userId]
      );
      if (!rows[0]) {
        socket.close();
        return;
      }
      userRating = {
        bullet: rows[0].bulletRating,
        blitz: rows[0].blitzRating,
        rapid: rows[0].rapidRating,
      };
      avatarUrl = rows[0].avatarUrl || "";
    } finally {
      client.release();
    }

    // Register connection
    matchmakingConnectionManager.addConnection(userId, socket);

    // Immediately start matchmaking with the provided time and increment
    try {
      await matchmakingHandler.findMatch(
        socket,
        userId,
        username,
        avatarUrl,
        userRating,
        time,
        increment
      );
    } catch (error) {
      fastify.log.error({ error }, "Error starting matchmaking");
      const errorMsg: MatchmakingMessage = {
        type: "error",
        data: {
          message: error instanceof Error ? error.message : "Unknown error",
        },
      };
      socket.send(JSON.stringify(errorMsg));
    }

    // Handle cancel request
    socket.on("message", async (rawMessage: Buffer) => {
      try {
        const message: MatchmakingMessage = JSON.parse(rawMessage.toString());
        if (message.type === "cancel_match") {
          await matchmakingHandler.handleDisconnect(userId);
          socket.close();
        }
      } catch (error) {
        fastify.log.error({ error }, "Error handling message");
      }
    });

    // Handle disconnect
    socket.on("close", async () => {
      try {
        await matchmakingHandler.handleDisconnect(userId);
      } catch (error) {
        fastify.log.error({ error }, "Error handling disconnect");
      }
    });

    socket.on("error", (error: Error) => {
      fastify.log.error({ error }, "WebSocket error");
    });
  });
}
