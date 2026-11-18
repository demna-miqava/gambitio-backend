import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { GameService } from "../services/gameService.js";
import { AppError } from "../errors/AppError.js";
import { authMiddleware } from "../middleware/auth.js";
import { gameRepository } from "../repositories/gameRepository.js";
import { saveBotGameSchema } from "../schemas/gameSchemas.js";
import { SHARE_TOKEN_PATTERN } from "../utils/shareToken.js";

const gameIdParams = z.object({ id: z.coerce.number().int().positive().max(2_147_483_647) });
const shareTokenParams = z.object({ token: z.string().regex(SHARE_TOKEN_PATTERN) });
const shareLimit = { rateLimit: { max: 30, timeWindow: "1 minute" } };
const publicLimit = { rateLimit: { max: 60, timeWindow: "1 minute" } };

export async function gameRoutes(fastify: FastifyInstance) {
  const gameService = new GameService(fastify);

  // GET /games/active - The signed-in user's game in progress, if any
  fastify.get("/games/active", { preHandler: authMiddleware }, async (request) => {
    const gameId = await gameRepository.findActiveGameIdForUser(fastify.pg, request.user!.id);
    return { gameId };
  });

  // POST /games/bot - Store a finished (unrated) game against a computer bot.
  // At most BOT_GAMES_PER_DAY a day per user (GameService.saveBotGame)
  fastify.post(
    "/games/bot",
    {
      preHandler: authMiddleware,
      // The PGN (MAX_BOT_GAME_PGN_LENGTH characters) as JSON, with room for
      // escaped newlines and names outside ASCII
      bodyLimit: 16 * 1024,
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

  // POST /games/:id/share - The game's share link, made on first use (its
  // players only, once it's over). The page is /share/<token> on the site.
  fastify.post("/games/:id/share", { preHandler: authMiddleware, config: shareLimit }, async (request) => {
    const { id } = gameIdParams.parse(request.params);
    return { token: await gameService.shareGame(id, request.user!.id) };
  });

  // DELETE /games/:id/share - Turns the link off (either player)
  fastify.delete("/games/:id/share", { preHandler: authMiddleware, config: shareLimit }, async (request, reply) => {
    const { id } = gameIdParams.parse(request.params);
    await gameService.unshareGame(id, request.user!.id);
    return reply.status(204).send();
  });

  // GET /shared-games/:token - A shared game, for anyone: no sign-in. The one
  // route that serves a game without one, so it has its own limit, counted
  // per address (there is no user to count by). A token that isn't one, or
  // that no game has (never shared, or turned off), is the same 404.
  fastify.get("/shared-games/:token", { config: publicLimit }, async (request, reply) => {
    const params = shareTokenParams.safeParse(request.params);
    const game = params.success ? await gameService.getSharedGame(params.data.token) : null;
    if (!game) throw new AppError("This game isn't shared", "SHARED_GAME_NOT_FOUND", 404);
    // A finished game only changes when a player renames or deletes their
    // account, or turns the link off: let the browser reuse it for a minute
    reply.header("Cache-Control", "private, max-age=60");
    return game;
  });
}
