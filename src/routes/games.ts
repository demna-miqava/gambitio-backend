import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { GameService } from "../services/gameService.js";

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
}
