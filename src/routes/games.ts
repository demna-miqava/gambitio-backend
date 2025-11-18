import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { GameService } from "../services/gameService.js";
import { paginationQuerySchema } from "../schemas/gameSchemas.js";
import { ZodError } from "zod";

export async function gameRoutes(fastify: FastifyInstance) {
  const gameService = new GameService(fastify);

  // GET /games/:id - Get game by ID
  fastify.get<{
    Params: { id: string };
  }>(
    "/games/:id",
    async (
      request: FastifyRequest<{
        Params: { id: string };
      }>,
      reply: FastifyReply
    ) => {
      try {
        const gameId = parseInt(request.params.id, 10);

        if (isNaN(gameId)) {
          return reply.status(400).send({ error: "Invalid game ID" });
        }

        const game = await gameService.getGameByIdFormatted(gameId);

        if (!game) {
          return reply.status(404).send({ error: "Game not found" });
        }

        return reply.status(200).send(game);
      } catch (error) {
        fastify.log.error(error);
        return reply.status(500).send({ error: "Failed to fetch game" });
      }
    }
  );

  // GET /games/archive/:username - Get paginated game history for a user
  fastify.get<{
    Params: { username: string };
    Querystring: { page?: string; limit?: string };
  }>(
    "/games/archive/:username",
    async (
      request: FastifyRequest<{
        Params: { username: string };
        Querystring: { page?: string; limit?: string };
      }>,
      reply: FastifyReply
    ) => {
      try {
        const { username } = request.params;

        // Validate query parameters
        const validatedQuery = paginationQuerySchema.parse(request.query);

        // Fetch paginated games
        const result = await gameService.getGamesByUsername(
          username,
          validatedQuery.page,
          validatedQuery.limit
        );

        return reply.status(200).send(result);
      } catch (error) {
        // Handle Zod validation errors
        if (error instanceof ZodError) {
          return reply.status(400).send({
            error: "Validation error",
            details: error.issues,
          });
        }

        fastify.log.error(error);
        return reply.status(500).send({ error: "Failed to fetch games" });
      }
    }
  );
}
