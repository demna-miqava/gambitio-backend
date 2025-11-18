import type { FastifyInstance } from "fastify";
import type {
  GameResponse,
  PaginatedGamesResponse,
  Game,
} from "../models/Game.js";
import { GameRepository } from "../repositories/gameRepository.js";
import { getTimeControl } from "../models/common.js";
import type { TimeControl } from "../models/common.js";
import { calculateRatingChanges } from "../utils/ratingHelpers.js";

export class GameService {
  private gameRepository: GameRepository;
  private fastify: FastifyInstance;

  constructor(fastify: FastifyInstance) {
    this.fastify = fastify;
    this.gameRepository = new GameRepository(fastify);
  }

  /**
   * Get game by ID (internal use)
   */
  async getGameById(gameId: number): Promise<Game | null> {
    return await this.gameRepository.findById(gameId);
  }

  /**
   * Get game by ID formatted for API response
   */
  async getGameByIdFormatted(gameId: number): Promise<GameResponse | null> {
    const game = await this.gameRepository.findById(gameId);
    if (!game) return null;

    return {
      id: game.id,
      createdAt: game.createdAt,
      pgn: game.pgn,
      fen: game.fen,
      winnerId: game.winnerId,
      numMoves: game.numMoves,
      time: game.time,
      increment: game.increment,
      type: getTimeControl(game.time),
      status: game.status,
      whitePlayer: {
        id: game.whiteId,
        username: game.whiteUsername,
        rating: game.whiteRating,
        avatarUrl: game.whiteAvatarUrl,
      },
      blackPlayer: {
        id: game.blackId,
        username: game.blackUsername,
        rating: game.blackRating,
        avatarUrl: game.blackAvatarUrl,
      },
    };
  }

  /**
   * Update game with new move
   */
  async updateMove(
    gameId: number,
    fen: string,
    pgn: string,
    numMoves: number
  ): Promise<void> {
    await this.gameRepository.updateMove(gameId, fen, pgn, numMoves);
  }

  /**
   * End game with rating updates
   */
  async endGame(
    gameId: number,
    winnerId: number | null,
    status: "finished" | "abandoned" = "finished",
    result?: "white_win" | "black_win" | "draw" | "aborted"
  ): Promise<{
    whiteRatingChange: number;
    blackRatingChange: number;
    whiteNewRating: number;
    blackNewRating: number;
  } | null> {
    // Get game info before ending it
    const game = await this.gameRepository.findById(gameId);
    if (!game) return null;

    // Calculate rating changes if result is provided
    let ratingChanges = null;
    if (result) {
      ratingChanges = calculateRatingChanges(
        game.whiteRating,
        game.blackRating,
        result
      );

      // Update ratings in database (only if not aborted)
      if (result !== "aborted" && game.whiteId && game.blackId) {
        const timeControl = getTimeControl(game.time);
        await this.updatePlayerRatings(
          game.whiteId,
          game.blackId,
          timeControl,
          ratingChanges.whiteNewRating,
          ratingChanges.blackNewRating
        );
      }
    }

    // End game in database
    await this.gameRepository.endGame(gameId, winnerId, status);

    return ratingChanges;
  }

  /**
   * Delete game (for abort)
   */
  async deleteGame(gameId: number): Promise<void> {
    await this.gameRepository.deleteById(gameId);
  }

  /**
   * Update player ratings in the database
   */
  async updatePlayerRatings(
    whiteId: number,
    blackId: number,
    timeControl: TimeControl,
    whiteNewRating: number,
    blackNewRating: number
  ): Promise<void> {
    const client = await this.fastify.pg.connect();
    try {
      const ratingColumn =
        timeControl === "bullet"
          ? "bulletRating"
          : timeControl === "blitz"
          ? "blitzRating"
          : "rapidRating";

      await client.query(
        `UPDATE users SET "${ratingColumn}" = $1 WHERE id = $2`,
        [whiteNewRating, whiteId]
      );

      await client.query(
        `UPDATE users SET "${ratingColumn}" = $1 WHERE id = $2`,
        [blackNewRating, blackId]
      );
    } finally {
      client.release();
    }
  }

  async getGamesByUsername(
    username: string,
    page: number = 1,
    limit: number = 10
  ): Promise<PaginatedGamesResponse> {
    const normalizedPage = Math.max(1, page);
    const normalizedLimit = Math.min(Math.max(1, limit), 100); // Max 100 per page
    const offset = (normalizedPage - 1) * normalizedLimit;

    // Fetch games and total count
    const { games, total } = await this.gameRepository.findByUsername(
      username,
      normalizedLimit,
      offset
    );

    // Transform to GameResponse format
    const gameResponses: GameResponse[] = games.map((game) => ({
      id: game.id,
      createdAt: game.createdAt,
      pgn: game.pgn,
      fen: game.fen,
      winnerId: game.winnerId,
      numMoves: game.numMoves,
      time: game.time,
      increment: game.increment,
      type: getTimeControl(game.time),
      status: game.status,
      whitePlayer: {
        id: game.whiteId,
        username: game.whiteUsername,
        rating: game.whiteRating,
        avatarUrl: game.whiteAvatarUrl,
      },
      blackPlayer: {
        id: game.blackId,
        username: game.blackUsername,
        rating: game.blackRating,
        avatarUrl: game.blackAvatarUrl,
      },
    }));

    // Calculate total pages
    const totalPages = Math.ceil(total / normalizedLimit);

    return {
      data: gameResponses,
      pagination: {
        page: normalizedPage,
        limit: normalizedLimit,
        total,
        totalPages,
      },
    };
  }
}
