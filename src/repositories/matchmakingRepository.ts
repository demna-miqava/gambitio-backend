import type { FastifyInstance } from "fastify";
import type { MatchmakingRequest, TimeControl } from "../models/Matchmaking.js";

export class MatchmakingRepository {
  constructor(private fastify: FastifyInstance) {}

  /**
   * Create a new matchmaking request
   */
  async create(
    userId: number,
    rating: number,
    time: number,
    increment: number | null
  ): Promise<MatchmakingRequest> {
    const client = await this.fastify.pg.connect();
    try {
      const { rows } = await client.query<MatchmakingRequest>(
        `INSERT INTO matchmaking (rating, time, increment, "userId")
         VALUES ($1, $2, $3, $4)
         RETURNING id, "createdAt", rating, time, increment, "userId"`,
        [rating, time, increment, userId]
      );
      return rows[0]!;
    } finally {
      client.release();
    }
  }

  /**
   * Find a matching opponent within rating range based on time control type
   */
  async findMatch(
    time: number,
    increment: number | null,
    rating: number,
    ratingRange: number,
    currentUserId: number,
    timeControl: TimeControl
  ): Promise<MatchmakingRequest | null> {
    const client = await this.fastify.pg.connect();
    try {
      // Determine which rating column to use
      const ratingColumn =
        timeControl === "bullet"
          ? "bulletRating"
          : timeControl === "blitz"
          ? "blitzRating"
          : "rapidRating";

      const { rows } = await client.query<MatchmakingRequest>(
        `SELECT m.id, m."createdAt", m.rating, m.time, m.increment, m."userId"
         FROM matchmaking m
         JOIN users u ON m."userId" = u.id
         WHERE m.time = $1
           AND m.increment IS NOT DISTINCT FROM $2
           AND u."${ratingColumn}" BETWEEN $3 AND $4
           AND m."userId" != $5
         ORDER BY m."createdAt" ASC
         LIMIT 1`,
        [
          time,
          increment,
          rating - ratingRange,
          rating + ratingRange,
          currentUserId,
        ]
      );
      return rows[0] || null;
    } finally {
      client.release();
    }
  }

  /**
   * Delete a matchmaking request by ID
   */
  async deleteById(id: number): Promise<void> {
    const client = await this.fastify.pg.connect();
    try {
      await client.query(`DELETE FROM matchmaking WHERE id = $1`, [id]);
    } finally {
      client.release();
    }
  }

  /**
   * Delete a matchmaking request by user ID
   */
  async deleteByUserId(userId: number): Promise<void> {
    const client = await this.fastify.pg.connect();
    try {
      await client.query(`DELETE FROM matchmaking WHERE "userId" = $1`, [
        userId,
      ]);
    } finally {
      client.release();
    }
  }

  /**
   * Clean up old matchmaking requests (older than X minutes)
   */
  async cleanupOldRequests(minutesOld: number = 5): Promise<void> {
    const client = await this.fastify.pg.connect();
    try {
      await client.query(
        `DELETE FROM matchmaking
         WHERE "createdAt" < NOW() - INTERVAL '${minutesOld} minutes'`
      );
    } finally {
      client.release();
    }
  }
}
