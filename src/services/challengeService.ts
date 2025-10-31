import type { FastifyInstance } from "fastify";

export interface Challenge {
  id: number;
  createdAt: Date;
  challengerId: number;
  challengedId: number;
  challengerUsername: string;
  challengedUsername: string | null;
  challengerAvatarUrl: string | null;
  challengedAvatarUrl: string | null;
  time: number;
  increment: number | null;
  challengerColor: string;
}

/**
 * Service for managing challenge-related database operations
 */
export class ChallengeService {
  constructor(private fastify: FastifyInstance) {}

  async getChallengesReceivedByUser(userId: number): Promise<Challenge[]> {
    const client = await this.fastify.pg.connect();
    try {
      const { rows } = await client.query<Challenge>(
        `SELECT * FROM challenges
         WHERE "challengedId" = $1
         ORDER BY "createdAt" DESC`,
        [userId]
      );
      return rows;
    } finally {
      client.release();
    }
  }

  async deleteAllUserChallenges(userId: number): Promise<void> {
    const client = await this.fastify.pg.connect();
    try {
      // Delete all challenges where this user is the challenger or challenged
      const result = await client.query(
        `DELETE FROM challenges
         WHERE "challengerId" = $1 OR "challengedId" = $1`,
        [userId]
      );

      this.fastify.log.info(
        { userId, deletedCount: result.rowCount },
        "Deleted all user challenges"
      );
    } finally {
      client.release();
    }
  }
}
