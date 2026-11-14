import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { authMiddleware } from "../middleware/auth.js";

const seriesParams = z.object({ id: z.coerce.number().int().positive().max(2_147_483_647) });
const userParams = z.object({ userId: z.coerce.number().int().positive().max(2_147_483_647) });
const listQuery = z.object({ limit: z.coerce.number().int().min(1).max(50).default(20) });

export async function seriesRoutes(fastify: FastifyInstance) {
  /** GET /series/:id - A series with its games (and the one being played, if any) */
  fastify.get("/series/:id", { preHandler: authMiddleware }, async (request) => {
    const { id } = seriesParams.parse(request.params);
    return fastify.series.getSeries(id);
  });

  /** POST /series/:id/resign - Give the series to the opponent (between games) */
  fastify.post("/series/:id/resign", { preHandler: authMiddleware }, async (request) => {
    const { id } = seriesParams.parse(request.params);
    return { series: await fastify.series.resign(id, request.user!.id) };
  });

  /** GET /users/:userId/series - A player's series, newest first */
  fastify.get(
    "/users/:userId/series",
    { preHandler: authMiddleware, config: { rateLimit: { max: 60, timeWindow: "1 minute" } } },
    async (request) => {
      const { userId } = userParams.parse(request.params);
      const { limit } = listQuery.parse(request.query);
      return { data: await fastify.series.listForUser(userId, limit) };
    }
  );

  /** GET /users/:userId/head-to-head - The signed-in player's record against this one */
  fastify.get(
    "/users/:userId/head-to-head",
    { preHandler: authMiddleware, config: { rateLimit: { max: 60, timeWindow: "1 minute" } } },
    async (request) => {
      const { userId } = userParams.parse(request.params);
      return fastify.series.headToHead(request.user!.id, userId);
    }
  );
}
