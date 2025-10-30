import type { FastifyInstance } from "fastify";
import { matchmakingWebSocketRoute } from "./matchmaking.js";
import { gameWebSocketRoute } from "./game.js";
import { notificationWebSocketRoute } from "./notifications.js";

export async function webSocketRoutes(fastify: FastifyInstance) {
  // Register all WebSocket routes under /ws prefix
  await fastify.register(matchmakingWebSocketRoute, { prefix: "/ws" });
  await fastify.register(gameWebSocketRoute, { prefix: "/ws" });
  await fastify.register(notificationWebSocketRoute, { prefix: "/ws" });
}
