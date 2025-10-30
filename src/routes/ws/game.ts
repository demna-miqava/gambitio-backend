import type { FastifyInstance } from "fastify";
import { authenticateWebSocket } from "../../middleware/wsAuth.js";
import { GameHandler } from "../../handlers/gameHandler.js";
import { gameConnectionManager } from "../../utils/wsConnectionManager.js";
import type { GameWebSocketMessage } from "../../models/GameWebSocket.js";

export async function gameWebSocketRoute(fastify: FastifyInstance) {
  const gameHandler = new GameHandler(fastify);

  fastify.get<{
    Params: { id: string };
  }>("/game/:id", { websocket: true }, async (socket, request) => {
    // Authenticate user
    const decoded = await authenticateWebSocket(request, socket);
    if (!decoded) return;

    const userId = decoded.userId;

    // Parse path parameter
    const gameIdParam = request.params.id;

    const gameId = parseInt(gameIdParam, 10);

    if (isNaN(gameId) || gameId <= 0) {
      const errorMsg: GameWebSocketMessage = {
        type: "error",
        message: "Invalid gameId parameter",
      };
      socket.send(JSON.stringify(errorMsg));
      socket.close();
      return;
    }

    // Register connection
    gameConnectionManager.addConnection(userId, socket);

    // Send initial game state
    await gameHandler.sendInitialGameState(socket, gameId);

    // Handle incoming messages
    socket.on("message", async (rawMessage: Buffer) => {
      try {
        const message: GameWebSocketMessage = JSON.parse(rawMessage.toString());
        await gameHandler.handleMessage(message, gameId, userId);
      } catch (error) {
        fastify.log.error({ error }, "Error handling game message");
        const errorMsg: GameWebSocketMessage = {
          type: "error",
          message: error instanceof Error ? error.message : "Unknown error",
        };
        socket.send(JSON.stringify(errorMsg));
      }
    });

    // Handle disconnect
    socket.on("close", async () => {
      try {
        gameConnectionManager.removeConnection(userId);
      } catch (error) {
        fastify.log.error({ error }, "Error handling disconnect");
      }
    });

    socket.on("error", (error: Error) => {
      fastify.log.error({ error }, "WebSocket error");
    });
  });
}
