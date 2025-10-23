import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { GameService } from "../services/gameService.js";
import { paginationQuerySchema } from "../schemas/gameSchemas.js";
import { ZodError } from "zod";

export async function gameRoutes(fastify: FastifyInstance) {
  const gameService = new GameService(fastify);

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
