import type { FastifyInstance } from "fastify";
import { FriendService } from "../services/friendService.js";
import {
  searchQuerySchema,
  suggestionsQuerySchema,
  friendIdParamSchema,
} from "../schemas/friendSchemas.js";
import { authMiddleware } from "../middleware/auth.js";

export async function friendsRoutes(fastify: FastifyInstance) {
  const friendService = new FriendService(fastify);

  /**
   * GET /api/friends/suggestions?q=username
   * Friend suggestions (max 5), optionally filtered by username
   */
  fastify.get("/friends/suggestions", { preHandler: authMiddleware }, async (request) => {
    const { q } = suggestionsQuerySchema.parse(request.query);
    return { data: await friendService.getFriendSuggestions(request.user!.id, q) };
  });

  /**
   * GET /api/friends/search?q=username&page=1&limit=10
   * The user's friends (paginated, optionally filtered by username)
   */
  fastify.get("/friends/search", { preHandler: authMiddleware }, async (request) => {
    const { q, page, limit } = searchQuerySchema.parse(request.query);
    return friendService.getFriends(request.user!.id, page, limit, q);
  });

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
