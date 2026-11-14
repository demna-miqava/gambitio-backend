import type { FastifyInstance } from "fastify";
import { LeaderboardService } from "../services/leaderboardService.js";
import { leaderboardQuerySchema } from "../schemas/leaderboardSchemas.js";
import { authMiddleware } from "../middleware/auth.js";

export async function leaderboardRoutes(fastify: FastifyInstance) {
  const leaderboardService = new LeaderboardService(fastify);

  /**
   * GET /api/leaderboard?variant=bullet|blitz|rapid&scope=global|friends&page=1&limit=10
   * Ranked players (signed-in users) plus the caller's own entry ("me").
   */
  fastify.get("/leaderboard", { preHandler: authMiddleware }, async (request) => {
    const { variant, scope, page, limit } = leaderboardQuerySchema.parse(request.query);
    return leaderboardService.getLeaderboard({ userId: request.user!.id, variant, scope, page, limit });
  });
}
