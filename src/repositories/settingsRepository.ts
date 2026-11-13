import type { FastifyInstance } from "fastify";
import type { Settings, UpdateSettingsRequest } from "../models/Settings.js";

export class SettingsRepository {
  constructor(private fastify: FastifyInstance) {}

  /**
   * Get user settings
   */
  async getSettings(userId: number): Promise<Settings | null> {
    const client = this.fastify.pg;
    const { rows } = await client.query<Settings>(
      `SELECT * FROM user_settings WHERE "userId" = $1`,
      [userId]
    );

    return rows[0] || null;
  }

  /**
   * Update user settings (partial update)
   */
  async updateSettings(
    userId: number,
    updates: UpdateSettingsRequest
  ): Promise<Settings> {
    const client = this.fastify.pg;
    // Build dynamic SET clause
    const fields = Object.keys(updates);
    const setClause = fields
      .map((field, index) => `"${field}" = $${index + 2}`)
      .join(", ");
    const values = Object.values(updates);

    const { rows } = await client.query<Settings>(
      `UPDATE user_settings
       SET ${setClause}
       WHERE "userId" = $1
       RETURNING *`,
      [userId, ...values]
    );

    return rows[0]!;
  }

  /**
   * Create default settings for a new user
   */
  async createDefaultSettings(userId: number): Promise<Settings> {
    const client = this.fastify.pg;
    // Two first requests at once: the loser of the insert reads the winner's row
    const { rows } = await client.query<Settings>(
      `INSERT INTO user_settings ("userId")
       VALUES ($1)
       ON CONFLICT ("userId") DO NOTHING
       RETURNING *`,
      [userId]
    );
    if (rows[0]) return rows[0];
    const existing = await this.getSettings(userId);
    return existing!;
  }
}
