import type { FastifyInstance } from "fastify";
import type { User, UserResponse, CreateClerkUserData } from "../models/User.js";

export class UserRepository {
  constructor(private fastify: FastifyInstance) {}

  async findById(id: number): Promise<UserResponse | null> {
    const client = await this.fastify.pg.connect();
    try {
      const { rows } = await client.query<UserResponse>(
        `SELECT id, "clerkId", username, "createdAt", "rapidRating", "blitzRating", "bulletRating",
                "highestRapidRating", "highestBlitzRating", "highestBulletRating"
         FROM users WHERE id = $1`,
        [id]
      );
      return rows[0] || null;
    } finally {
      client.release();
    }
  }

  async findByClerkId(clerkId: string): Promise<UserResponse | null> {
    const client = await this.fastify.pg.connect();
    try {
      const { rows } = await client.query<UserResponse>(
        `SELECT id, "clerkId", username, "createdAt", "rapidRating", "blitzRating", "bulletRating",
                "highestRapidRating", "highestBlitzRating", "highestBulletRating"
         FROM users WHERE "clerkId" = $1`,
        [clerkId]
      );
      return rows[0] || null;
    } finally {
      client.release();
    }
  }

  async findFullByClerkId(clerkId: string): Promise<User | null> {
    const client = await this.fastify.pg.connect();
    try {
      const { rows } = await client.query<User>(
        `SELECT * FROM users WHERE "clerkId" = $1`,
        [clerkId]
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

  async create(userData: CreateClerkUserData): Promise<UserResponse> {
    const client = await this.fastify.pg.connect();
    try {
      const { rows } = await client.query<UserResponse>(
        `INSERT INTO users (
          "clerkId",
          email,
          username,
          "rapidRating",
          "blitzRating",
          "bulletRating",
          "highestRapidRating",
          "highestBlitzRating",
          "highestBulletRating"
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        RETURNING id, "clerkId", username, "createdAt", "rapidRating", "blitzRating", "bulletRating",
                  "highestRapidRating", "highestBlitzRating", "highestBulletRating"`,
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
    } finally {
      client.release();
    }
  }

  async updateEmail(clerkId: string, newEmail: string): Promise<void> {
    const client = await this.fastify.pg.connect();
    try {
      await client.query(
        `UPDATE users SET email = $1 WHERE "clerkId" = $2`,
        [newEmail, clerkId]
      );
    } finally {
      client.release();
    }
  }

  async updateUsername(clerkId: string, newUsername: string): Promise<void> {
    const client = await this.fastify.pg.connect();
    try {
      await client.query(
        `UPDATE users SET username = $1 WHERE "clerkId" = $2`,
        [newUsername, clerkId]
      );
    } finally {
      client.release();
    }
  }
}
