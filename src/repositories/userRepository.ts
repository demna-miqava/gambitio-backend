import type { FastifyInstance } from "fastify";
import type { User, UserResponse, CreateUserData } from "../models/User.js";

export class UserRepository {
  constructor(private fastify: FastifyInstance) {}

  async findById(id: number): Promise<UserResponse | null> {
    const client = await this.fastify.pg.connect();
    try {
      const { rows } = await client.query<UserResponse>(
        `SELECT id, username, "createdAt", "rapidRating", "blitzRating", "bulletRating",
                "highestRapidRating", "highestBlitzRating", "highestBulletRating"
         FROM users WHERE id = $1`,
        [id]
      );
      return rows[0] || null;
    } finally {
      client.release();
    }
  }

  async findByEmail(email: string): Promise<User | null> {
    const client = await this.fastify.pg.connect();
    try {
      const { rows } = await client.query<User>(
        `SELECT * FROM users WHERE email = $1`,
        [email]
      );
      return rows[0] || null;
    } finally {
      client.release();
    }
  }

  async findByUsername(username: string): Promise<User | null> {
    const client = await this.fastify.pg.connect();
    try {
      const { rows } = await client.query<User>(
        `SELECT * FROM users WHERE username = $1`,
        [username]
      );
      return rows[0] || null;
    } finally {
      client.release();
    }
  }

  async findByEmailOrUsername(emailOrUsername: string): Promise<User | null> {
    const client = await this.fastify.pg.connect();
    try {
      const { rows } = await client.query<User>(
        `SELECT * FROM users WHERE email = $1 OR username = $1`,
        [emailOrUsername]
      );
      return rows[0] || null;
    } finally {
      client.release();
    }
  }

  async create(userData: CreateUserData): Promise<UserResponse> {
    const client = await this.fastify.pg.connect();
    try {
      const { rows } = await client.query<UserResponse>(
        `INSERT INTO users (
          email,
          username,
          password,
          "rapidRating",
          "blitzRating",
          "bulletRating",
          "highestRapidRating",
          "highestBlitzRating",
          "highestBulletRating"
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        RETURNING id, username, "createdAt", "rapidRating", "blitzRating", "bulletRating",
                  "highestRapidRating", "highestBlitzRating", "highestBulletRating"`,
        [
          userData.email,
          userData.username,
          userData.password_hash,
          userData.rapidRating,
          userData.blitzRating,
          userData.bulletRating,
          userData.highestRapidRating,
          userData.highestBlitzRating,
          userData.highestBulletRating,
        ]
      );
      return rows[0]!;
    } finally {
      client.release();
    }
  }

  async updatePassword(userId: number, newPasswordHash: string): Promise<void> {
    const client = await this.fastify.pg.connect();
    try {
      await client.query(
        `UPDATE users SET password = $1 WHERE id = $2`,
        [newPasswordHash, userId]
      );
    } finally {
      client.release();
    }
  }

  async getPasswordHash(userId: number): Promise<string | null> {
    const client = await this.fastify.pg.connect();
    try {
      const { rows } = await client.query<{ password: string }>(
        `SELECT password FROM users WHERE id = $1`,
        [userId]
      );
      return rows[0]?.password || null;
    } finally {
      client.release();
    }
  }

  async updateEmail(userId: number, newEmail: string): Promise<void> {
    const client = await this.fastify.pg.connect();
    try {
      await client.query(
        `UPDATE users SET email = $1 WHERE id = $2`,
        [newEmail, userId]
      );
    } finally {
      client.release();
    }
  }
}
