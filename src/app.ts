import fastify from "fastify";
import type { FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import { registerPostgres } from "./plugins/postgres.js";
import { userRoutes } from "./routes/users.js";

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
  });

  // Register routes
  await app.register(userRoutes, { prefix: "/api" });

  return app;
}
