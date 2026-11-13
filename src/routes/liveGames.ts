import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { authMiddleware } from "../middleware/auth.js";
import { gameRepository } from "../repositories/gameRepository.js";
import { toLiveGameSummary } from "../services/gameService.js";

/** Most friends' games returned; a user rarely has more friends playing at once. */
const FRIENDS_LIVE_LIMIT = 50;

const topLiveQuery = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(12),
});

/**
 * Games in progress, for spectators (the Watch page). Watching itself goes
 * through the game WebSocket, which anyone signed in may open.
 */
export async function liveGameRoutes(fastify: FastifyInstance) {
  // GET /games/live/friends - The signed-in user's friends' games in progress
  fastify.get("/games/live/friends", { preHandler: authMiddleware }, async (request) => {
    const games = await gameRepository.findLiveForFriends(fastify.pg, request.user!.id, FRIENDS_LIVE_LIMIT);
    return { data: games.map(toLiveGameSummary) };
  });

  // GET /games/live/top?limit=12 - Games in progress with the highest average rating
  fastify.get("/games/live/top", { preHandler: authMiddleware }, async (request) => {
    const { limit } = topLiveQuery.parse(request.query);
    const games = await gameRepository.findTopLive(fastify.pg, limit);
    return { data: games.map(toLiveGameSummary) };
  });
}
