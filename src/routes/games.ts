import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { GameService } from "../services/gameService.js";
import { AppError } from "../errors/AppError.js";
import { authMiddleware } from "../middleware/auth.js";
import { gameRepository } from "../repositories/gameRepository.js";
import { saveBotGameSchema } from "../schemas/gameSchemas.js";

const gameIdParams = z.object({ id: z.coerce.number().int().positive() });

export async function gameRoutes(fastify: FastifyInstance) {
  const gameService = new GameService(fastify);

  // GET /games/active - The signed-in user's game in progress, if any
  fastify.get("/games/active", { preHandler: authMiddleware }, async (request) => {
    const gameId = await gameRepository.findActiveGameIdForUser(fastify.pg, request.user!.id);
    return { gameId };
  });

  // POST /games/bot - Store a finished (unrated) game against a computer bot
  fastify.post(
    "/games/bot",
    {
      preHandler: authMiddleware,
      bodyLimit: 32 * 1024,
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
    },
    async (request, reply) => {
      const body = saveBotGameSchema.parse(request.body);
      const game = await gameService.saveBotGame(request.user!.id, body);
      return reply.status(201).send(game);
    }
  );

  // GET /games/:id
  fastify.get("/games/:id", { preHandler: authMiddleware }, async (request) => {
    const { id } = gameIdParams.parse(request.params);
    const game = await gameService.getGameById(id);
    if (!game) throw new AppError("Game not found", "GAME_NOT_FOUND", 404);
    return game;
  });
}
