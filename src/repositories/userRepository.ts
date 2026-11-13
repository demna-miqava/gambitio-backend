import type { FastifyInstance } from "fastify";
import type { Queryable } from "../db.js";
import type { User, UserResponse, CreateClerkUserData } from "../models/User.js";

/** Peaks are never reported below the current rating (see migration 013). */
const USER_RESPONSE_COLUMNS = `id, "clerkId", username, "avatarUrl", "createdAt",
  "rapidRating", "blitzRating", "bulletRating",
  GREATEST("highestRapidRating", "rapidRating") AS "highestRapidRating",
  GREATEST("highestBlitzRating", "blitzRating") AS "highestBlitzRating",
  GREATEST("highestBulletRating", "bulletRating") AS "highestBulletRating",
  "puzzleRating", GREATEST("highestPuzzleRating", "puzzleRating") AS "highestPuzzleRating"`;

export class UserRepository {
  constructor(private fastify: FastifyInstance) {}

  async findById(id: number): Promise<UserResponse | null> {
    const { rows } = await this.fastify.pg.query<UserResponse>(
      `SELECT ${USER_RESPONSE_COLUMNS} FROM users WHERE id = $1`,
      [id]
    );
    return rows[0] ?? null;
  }

  async findByClerkId(clerkId: string): Promise<UserResponse | null> {
    const { rows } = await this.fastify.pg.query<UserResponse>(
      `SELECT ${USER_RESPONSE_COLUMNS} FROM users WHERE "clerkId" = $1`,
      [clerkId]
    );
    return rows[0] ?? null;
  }

  /** Case-insensitive, matching the unique index on lower(username). */
  async findByUsername(username: string): Promise<User | null> {
    const { rows } = await this.fastify.pg.query<User>(
      `SELECT * FROM users WHERE lower(username) = lower($1)`,
      [username]
    );
    return rows[0] ?? null;
  }

  async create(db: Queryable, userData: CreateClerkUserData): Promise<UserResponse> {
    const { rows } = await db.query<UserResponse>(
      `INSERT INTO users (
        "clerkId", email, username, "rapidRating", "blitzRating", "bulletRating",
        "highestRapidRating", "highestBlitzRating", "highestBulletRating"
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      RETURNING ${USER_RESPONSE_COLUMNS}`,
      [
        userData.clerkId,
        userData.email,
        userData.username,
        userData.rapidRating,
        userData.blitzRating,
        userData.bulletRating,
        userData.highestRapidRating,
        userData.highestBlitzRating,
        userData.highestBulletRating,
      ]
    );
    return rows[0]!;
  }
}
