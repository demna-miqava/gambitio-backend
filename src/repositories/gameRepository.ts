import type { FastifyInstance } from "fastify";
import type { Game } from "../models/Game.js";

export class GameRepository {
  constructor(private fastify: FastifyInstance) {}

  /**
   * Get game by ID
   */
  async findById(gameId: number): Promise<Game | null> {
    const client = await this.fastify.pg.connect();
    try {
      const { rows } = await client.query<Game>(
        `SELECT
          id,
          "createdAt",
          pgn,
          fen,
          "winnerId",
          "numMoves",
          "whiteRating",
          "blackRating",
          time,
          increment,
          "whiteId",
          "blackId",
          "whiteUsername",
          "blackUsername",
          "whiteAvatarUrl",
          "blackAvatarUrl",
          status
         FROM games
         WHERE id = $1`,
        [gameId]
      );
      return rows[0] || null;
    } finally {
      client.release();
    }
  }

  /**
   * Update game move (fen, pgn, numMoves)
   */
  async updateMove(
    gameId: number,
    fen: string,
    pgn: string,
    numMoves: number
  ): Promise<void> {
    const client = await this.fastify.pg.connect();
    try {
      await client.query(
        `UPDATE games
         SET fen = $1, pgn = $2, "numMoves" = $3
         WHERE id = $4`,
        [fen, pgn, numMoves, gameId]
      );
    } finally {
      client.release();
    }
  }

  /**
   * End game with result
   */
  async endGame(
    gameId: number,
    winnerId: number | null,
    status: "finished" | "abandoned"
  ): Promise<void> {
    const client = await this.fastify.pg.connect();
    try {
      await client.query(
        `UPDATE games
         SET "winnerId" = $1, status = $2
         WHERE id = $3`,
        [winnerId, status, gameId]
      );
    } finally {
      client.release();
    }
  }

  /**
   * Delete game (for abort)
   */
  async deleteById(gameId: number): Promise<void> {
    const client = await this.fastify.pg.connect();
    try {
      await client.query(`DELETE FROM games WHERE id = $1`, [gameId]);
    } finally {
      client.release();
    }
  }

  async findByUsername(
    username: string,
    limit: number,
    offset: number
  ): Promise<{ games: Game[]; total: number }> {
    const client = await this.fastify.pg.connect();
    try {
      // Get total count for pagination
      const countResult = await client.query<{ count: string }>(
        `SELECT COUNT(*) as count
         FROM games
         WHERE "whiteUsername" = $1 OR "blackUsername" = $1`,
        [username]
      );
      const total = parseInt(countResult.rows[0]?.count || "0", 10);

      // Get paginated games
      const { rows } = await client.query<Game>(
        `SELECT
          id,
          "createdAt",
          pgn,
          fen,
          "winnerId",
          "numMoves",
          "whiteRating",
          "blackRating",
          time,
          increment,
          "whiteId",
          "blackId",
          "whiteUsername",
          "blackUsername",
          "whiteAvatarUrl",
          "blackAvatarUrl",
          status
         FROM games
         WHERE "whiteUsername" = $1 OR "blackUsername" = $1
         ORDER BY "createdAt" DESC
         LIMIT $2 OFFSET $3`,
        [username, limit, offset]
      );

      return { games: rows, total };
    } finally {
      client.release();
    }
  }

  async findByUserId(
    userId: number,
    limit: number,
    offset: number
  ): Promise<{ games: Game[]; total: number }> {
    const client = await this.fastify.pg.connect();
    try {
      // Get total count for pagination
      const countResult = await client.query<{ count: string }>(
        `SELECT COUNT(*) as count
         FROM games
         WHERE "whiteId" = $1 OR "blackId" = $1`,
        [userId]
      );
      const total = parseInt(countResult.rows[0]?.count || "0", 10);

      // Get paginated games
      const { rows } = await client.query<Game>(
        `SELECT
          id,
          "createdAt",
          pgn,
          fen,
          "winnerId",
          "numMoves",
          "whiteRating",
          "blackRating",
          time,
          increment,
          "whiteId",
          "blackId",
          "whiteUsername",
          "blackUsername",
          "whiteAvatarUrl",
          "blackAvatarUrl",
          status
         FROM games
         WHERE "whiteId" = $1 OR "blackId" = $1
         ORDER BY "createdAt" DESC
         LIMIT $2 OFFSET $3`,
        [userId, limit, offset]
      );

      return { games: rows, total };
    } finally {
      client.release();
    }
  }
}
