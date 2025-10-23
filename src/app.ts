import fastify from "fastify";
import type { FastifyInstance } from "fastify";
import { registerPostgres } from "./plugins/postgres.js";
import { userRoutes } from "./routes/users.js";
import cors from "@fastify/cors";

export async function buildApp(): Promise<FastifyInstance> {
  const app = fastify({
    logger: true,
  });

  // Register plugins
  await registerPostgres(app);

  await app.register(cors, {
    origin: true,
    credentials: true,
  });

  // Register routes
  await app.register(userRoutes, { prefix: "/api" });

  return app;
}
