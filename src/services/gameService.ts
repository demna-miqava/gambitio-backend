import type { FastifyInstance } from "fastify";
import type {
  GameResponse,
  PaginatedGamesResponse,
  Game,
} from "../models/Game.js";
import { GameRepository } from "../repositories/gameRepository.js";
import { getTimeControl } from "../models/common.js";

export class GameService {
  private gameRepository: GameRepository;

  constructor(fastify: FastifyInstance) {
    this.gameRepository = new GameRepository(fastify);
  }

  /**
   * Get game by ID
   */
  async getGameById(gameId: number): Promise<Game | null> {
    return await this.gameRepository.findById(gameId);
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
   * End game
   */
  async endGame(
    gameId: number,
    winnerId: number | null,
    status: "finished" | "abandoned" = "finished"
  ): Promise<void> {
    await this.gameRepository.endGame(gameId, winnerId, status);
  }

  /**
   * Delete game (for abort)
   */
  async deleteGame(gameId: number): Promise<void> {
    await this.gameRepository.deleteById(gameId);
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
