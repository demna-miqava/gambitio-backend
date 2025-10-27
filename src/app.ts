import fastify from "fastify";
import type { FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import { registerPostgres } from "./plugins/postgres.js";
import { userRoutes } from "./routes/users.js";
import { gameRoutes } from "./routes/games.js";
import { webSocketRoutes } from "./routes/ws/index.js";
import { friendsRoutes } from "./routes/friends.js";
import { friendRequestsRoutes } from "./routes/friendRequests.js";

export async function buildApp(): Promise<FastifyInstance> {
  const app = fastify({
    logger: true,
  });

  // Register plugins
  await app.register(cookie);

  await registerPostgres(app);

  await app.register(cors, {
    origin: true,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  });

  await app.register(websocket);

  // Register routes
  await app.register(userRoutes, { prefix: "/api" });
  await app.register(gameRoutes, { prefix: "/api" });
  await app.register(webSocketRoutes, { prefix: "/api" });
  await app.register(friendsRoutes, { prefix: "/api" });
  await app.register(friendRequestsRoutes, { prefix: "/api" });

  return app;
}
