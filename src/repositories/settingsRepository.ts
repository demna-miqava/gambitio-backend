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
   * Partial update in one statement, creating the row with defaults first if
   * it doesn't exist. Field names come from the validated settings schema.
   */
  async updateSettings(userId: number, updates: UpdateSettingsRequest): Promise<Settings> {
    const fields = Object.keys(updates);
    if (fields.length === 0) {
      return (await this.getSettings(userId)) ?? (await this.createDefaultSettings(userId));
    }
    const columns = fields.map((field) => `"${field}"`).join(", ");
    const placeholders = fields.map((_, index) => `$${index + 2}`).join(", ");
    const setClause = fields.map((field) => `"${field}" = EXCLUDED."${field}"`).join(", ");
    const { rows } = await this.fastify.pg.query<Settings>(
      `INSERT INTO user_settings ("userId", ${columns})
       VALUES ($1, ${placeholders})
       ON CONFLICT ("userId") DO UPDATE SET ${setClause}
       RETURNING *`,
      [userId, ...Object.values(updates)]
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
