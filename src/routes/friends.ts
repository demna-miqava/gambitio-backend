import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { FriendService } from "../services/friendService.js";
import {
  searchQuerySchema,
  suggestionsQuerySchema,
  friendIdParamSchema,
  type SearchQuery,
  type SuggestionsQuery,
  type FriendIdParam,
} from "../schemas/friendSchemas.js";
import { authMiddleware } from "../middleware/auth.js";

export async function friendsRoutes(fastify: FastifyInstance) {
  const friendService = new FriendService(fastify);

  /**
   * GET /api/friends/suggestions?q=username
   * Get friend suggestions (max 5)
   */
  fastify.get<{ Querystring: SuggestionsQuery }>(
    "/friends/suggestions",
    { onRequest: [authMiddleware] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        // Validate query parameters
        const validation = suggestionsQuerySchema.safeParse(request.query);
        if (!validation.success) {
          return reply.status(400).send({
            error: "Validation failed",
            details: validation.error.issues,
          });
        }

        const { q } = validation.data;

        const suggestions = await friendService.getFriendSuggestions(
          request.user!.userId,
          q
        );

        return reply.send(suggestions);
      } catch (error) {
        return reply.status(500).send({ error: "Internal server error" });
      }
    }
  );

  /**
   * GET /api/friends/search?q=username&page=1&limit=10
   * Get user's friends list (paginated, optionally filtered by username)
   */
  fastify.get<{ Querystring: SearchQuery }>(
    "/friends/search",
    { onRequest: [authMiddleware] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        // Validate query parameters
        const validation = searchQuerySchema.safeParse(request.query);
        if (!validation.success) {
          return reply.status(400).send({
            error: "Validation failed",
            details: validation.error.issues,
          });
        }

        const { q, page, limit } = validation.data;
        const pageNum = parseInt(page, 10);
        const limitNum = parseInt(limit, 10);

        const results = await friendService.getFriends(
          request.user!.userId,
          pageNum,
          limitNum,
          q
        );

        return reply.send(results);
      } catch (error) {
        return reply.status(500).send({ error: "Internal server error" });
      }
    }
  );

  /**
   * DELETE /api/friends/:friendId
   * Delete a friendship
   */
  fastify.delete<{ Params: FriendIdParam }>(
    "/friends/:friendId",
    { onRequest: [authMiddleware] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        // Validate path parameters
        const validation = friendIdParamSchema.safeParse(request.params);
        if (!validation.success) {
          return reply.status(400).send({
            error: "Validation failed",
            details: validation.error.issues,
          });
        }

        const friendId = parseInt(validation.data.friendId, 10);

        await friendService.deleteFriendship(request.user!.userId, friendId);

        return reply.send({ message: "Friendship deleted successfully" });
      } catch (error) {
        if (error instanceof Error) {
          if (error.message === "Not friends with this user") {
            return reply.status(404).send({ error: error.message });
          }
        }
        return reply.status(500).send({ error: "Internal server error" });
      }
    }
  );
}
