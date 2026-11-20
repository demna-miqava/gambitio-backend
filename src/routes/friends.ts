import type { FastifyInstance } from "fastify";
import { FriendService } from "../services/friendService.js";
import {
  suggestionsQuerySchema,
  friendIdParamSchema,
  opponentsQuerySchema,
} from "../schemas/friendSchemas.js";
import { authMiddleware } from "../middleware/auth.js";

export async function friendsRoutes(fastify: FastifyInstance) {
  const friendService = new FriendService(fastify);

  /**
   * GET /api/friends/suggestions?q=username
   * Friend suggestions (max 5), optionally filtered by username
   */
  fastify.get(
    "/friends/suggestions",
    { preHandler: authMiddleware, config: { rateLimit: { max: 60, timeWindow: "1 minute" } } }, async (request) => {
    const { q } = suggestionsQuerySchema.parse(request.query);
    return { data: await friendService.getFriendSuggestions(request.user!.id, q) };
  });

  /**
   * GET /api/friends/status
   * The signed-in user's friends who are online or playing (see
   * FriendService.getFriendStatuses). Clients poll it while a list is shown.
   */
  fastify.get(
    "/friends/status",
    { preHandler: authMiddleware, config: { rateLimit: { max: 60, timeWindow: "1 minute" } } },
    async (request) => ({ data: await friendService.getFriendStatuses(request.user!.id) })
  );

  /**
   * GET /api/friends/opponents?q=username&page=1&limit=20
   * The signed-in user's friends in the order you'd pick an opponent: online
   * first, then playing, then most recently played, then by username (see
   * FriendService.getOpponents). Clients poll it while it is shown.
   */
  fastify.get(
    "/friends/opponents",
    { preHandler: authMiddleware, config: { rateLimit: { max: 60, timeWindow: "1 minute" } } },
    async (request) => {
      const { page, limit, q } = opponentsQuerySchema.parse(request.query);
      const { friends, total } = await friendService.getOpponents(request.user!.id, { page, limit, searchQuery: q });
      return {
        data: friends,
        pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
      };
    }
  );

  /**
   * DELETE /api/friends/:friendId
   * Either user in the friendship can delete it
   */
  fastify.delete("/friends/:friendId", { preHandler: authMiddleware }, async (request) => {
    const { friendId } = friendIdParamSchema.parse(request.params);
    await friendService.deleteFriendship(request.user!.id, friendId);
    return { success: true, message: "Friendship deleted successfully" };
  });
}
