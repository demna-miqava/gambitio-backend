import type { FastifyInstance } from "fastify";
import type { Game } from "../models/Game.js";

export class GameRepository {
  constructor(private fastify: FastifyInstance) {}

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
}
