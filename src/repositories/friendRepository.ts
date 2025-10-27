import type { FastifyInstance } from "fastify";
import type {
  Friend,
  FriendRequest,
  FriendSuggestion,
  IncomingFriendRequestResponse,
  OutgoingFriendRequestResponse,
} from "../models/Friend.js";

export class FriendRepository {
  constructor(private fastify: FastifyInstance) {}

  /**
   * Get friend suggestions (paginated, excluding current friends)
   */
  async getFriendSuggestions(
    userId: number,
    limit: number,
    offset: number
  ): Promise<{ suggestions: FriendSuggestion[]; total: number }> {
    const client = await this.fastify.pg.connect();
    try {
      // Get total count of potential friends (excluding current friends and self)
      const { rows: countRows } = await client.query(
        `SELECT COUNT(*) as count
         FROM users
         WHERE id != $1
         AND id NOT IN (
           SELECT "userTwoId" FROM friends WHERE "userOneId" = $1
           UNION
           SELECT "userOneId" FROM friends WHERE "userTwoId" = $1
         )`,
        [userId]
      );
      const total = parseInt(countRows[0].count, 10);

      // Get paginated suggestions
      const { rows } = await client.query<FriendSuggestion>(
        `SELECT id, username, "avatarUrl"
         FROM users
         WHERE id != $1
         AND id NOT IN (
           SELECT "userTwoId" FROM friends WHERE "userOneId" = $1
           UNION
           SELECT "userOneId" FROM friends WHERE "userTwoId" = $1
         )
         ORDER BY username
         LIMIT $2 OFFSET $3`,
        [userId, limit, offset]
      );

      return { suggestions: rows, total };
    } finally {
      client.release();
    }
  }

  /**
   * Get user's friends list (paginated)
   * If searchQuery provided, filter friends by username
   */
  async getFriends(
    userId: number,
    limit: number,
    offset: number,
    searchQuery?: string
  ): Promise<{ suggestions: FriendSuggestion[]; total: number }> {
    const client = await this.fastify.pg.connect();
    try {
      if (searchQuery) {
        // Query with search filter
        const searchPattern = `%${searchQuery}%`;

        // Get total count of filtered friends
        const { rows: countRows } = await client.query(
          `SELECT COUNT(*) as count
           FROM friends f
           INNER JOIN users u ON (
             CASE
               WHEN f."userOneId" = $1 THEN u.id = f."userTwoId"
               WHEN f."userTwoId" = $1 THEN u.id = f."userOneId"
               ELSE FALSE
             END
           )
           WHERE (f."userOneId" = $1 OR f."userTwoId" = $1)
           AND u.username ILIKE $2`,
          [userId, searchPattern]
        );
        const total = parseInt(countRows[0].count, 10);

        // Get paginated filtered friends list
        const { rows } = await client.query<FriendSuggestion>(
          `SELECT
             u.id,
             u.username,
             u."avatarUrl",
             f."createdAt" as "friendsSince",
             u."blitzRating",
             u."bulletRating",
             u."rapidRating"
           FROM friends f
           INNER JOIN users u ON (
             CASE
               WHEN f."userOneId" = $1 THEN u.id = f."userTwoId"
               WHEN f."userTwoId" = $1 THEN u.id = f."userOneId"
               ELSE FALSE
             END
           )
           WHERE (f."userOneId" = $1 OR f."userTwoId" = $1)
           AND u.username ILIKE $2
           ORDER BY u.username
           LIMIT $3 OFFSET $4`,
          [userId, searchPattern, limit, offset]
        );

        return { suggestions: rows, total };
      } else {
        // Query without search filter
        // Get total count of friends
        const { rows: countRows } = await client.query(
          `SELECT COUNT(*) as count
           FROM friends
           WHERE "userOneId" = $1 OR "userTwoId" = $1`,
          [userId]
        );
        const total = parseInt(countRows[0].count, 10);

        // Get paginated friends list
        const { rows } = await client.query<FriendSuggestion>(
          `SELECT
             u.id,
             u.username,
             u."avatarUrl",
             f."createdAt" as "friendsSince",
             u."blitzRating",
             u."bulletRating",
             u."rapidRating"
           FROM friends f
           INNER JOIN users u ON (
             CASE
               WHEN f."userOneId" = $1 THEN u.id = f."userTwoId"
               WHEN f."userTwoId" = $1 THEN u.id = f."userOneId"
               ELSE FALSE
             END
           )
           WHERE (f."userOneId" = $1 OR f."userTwoId" = $1)
           ORDER BY u.username
           LIMIT $2 OFFSET $3`,
          [userId, limit, offset]
        );

        return { suggestions: rows, total };
      }
    } finally {
      client.release();
    }
  }

  async searchUsers(
    userId: number,
    searchQuery: string,
    limit: number,
    offset: number
  ): Promise<{ suggestions: FriendSuggestion[]; total: number }> {
    const client = await this.fastify.pg.connect();
    try {
      const searchPattern = `%${searchQuery}%`;

      // Get total count
      const { rows: countRows } = await client.query(
        `SELECT COUNT(*) as count
         FROM users
         WHERE id != $1
         AND username ILIKE $2
         AND id NOT IN (
           SELECT "userTwoId" FROM friends WHERE "userOneId" = $1
           UNION
           SELECT "userOneId" FROM friends WHERE "userTwoId" = $1
         )`,
        [userId, searchPattern]
      );
      const total = parseInt(countRows[0].count, 10);

      // Get paginated results
      const { rows } = await client.query<FriendSuggestion>(
        `SELECT id, username, "avatarUrl"
         FROM users
         WHERE id != $1
         AND username ILIKE $2
         AND id NOT IN (
           SELECT "userTwoId" FROM friends WHERE "userOneId" = $1
           UNION
           SELECT "userOneId" FROM friends WHERE "userTwoId" = $1
         )
         ORDER BY username
         LIMIT $3 OFFSET $4`,
        [userId, searchPattern, limit, offset]
      );

      return { suggestions: rows, total };
    } finally {
      client.release();
    }
  }

  async createFriendRequest(
    senderId: number,
    senderUsername: string,
    senderAvatarUrl: string | null,
    receiverId: number,
    receiverUsername: string,
    receiverAvatarUrl: string | null
  ): Promise<FriendRequest> {
    const client = await this.fastify.pg.connect();
    try {
      const { rows } = await client.query<FriendRequest>(
        `INSERT INTO friend_requests (
          "senderId", "receiverId", "senderUsername", "receiverUsername",
          "senderAvatarUrl", "receiverAvatarUrl"
        ) VALUES ($1, $2, $3, $4, $5, $6)
        RETURNING *`,
        [
          senderId,
          receiverId,
          senderUsername,
          receiverUsername,
          senderAvatarUrl,
          receiverAvatarUrl,
        ]
      );

      return rows[0];
    } finally {
      client.release();
    }
  }

  async getPendingFriendRequests(userId: number): Promise<{
    incoming: IncomingFriendRequestResponse[];
    outgoing: OutgoingFriendRequestResponse[];
  }> {
    const client = await this.fastify.pg.connect();
    try {
      // Get incoming requests (where user is receiver)
      const { rows: incomingRows } =
        await client.query<IncomingFriendRequestResponse>(
          `SELECT id, "senderId", "senderUsername", "senderAvatarUrl", "createdAt"
         FROM friend_requests
         WHERE "receiverId" = $1
         ORDER BY "createdAt" DESC`,
          [userId]
        );

      // Get outgoing requests (where user is sender)
      const { rows: outgoingRows } =
        await client.query<OutgoingFriendRequestResponse>(
          `SELECT id, "receiverId", "receiverUsername", "receiverAvatarUrl", "createdAt"
         FROM friend_requests
         WHERE "senderId" = $1
         ORDER BY "createdAt" DESC`,
          [userId]
        );

      return {
        incoming: incomingRows,
        outgoing: outgoingRows,
      };
    } finally {
      client.release();
    }
  }

  async friendRequestExists(
    senderId: number,
    receiverId: number
  ): Promise<boolean> {
    const client = await this.fastify.pg.connect();
    try {
      const { rows } = await client.query(
        `SELECT id FROM friend_requests
         WHERE ("senderId" = $1 AND "receiverId" = $2)
         OR ("senderId" = $2 AND "receiverId" = $1)`,
        [senderId, receiverId]
      );

      return rows.length > 0;
    } finally {
      client.release();
    }
  }

  async areFriends(userOneId: number, userTwoId: number): Promise<boolean> {
    const client = await this.fastify.pg.connect();
    try {
      const { rows } = await client.query(
        `SELECT id FROM friends
         WHERE ("userOneId" = $1 AND "userTwoId" = $2)
         OR ("userOneId" = $2 AND "userTwoId" = $1)`,
        [userOneId, userTwoId]
      );

      return rows.length > 0;
    } finally {
      client.release();
    }
  }

  async getFriendRequestById(requestId: number): Promise<FriendRequest | null> {
    const client = await this.fastify.pg.connect();
    try {
      const { rows } = await client.query<FriendRequest>(
        `SELECT * FROM friend_requests WHERE id = $1`,
        [requestId]
      );

      return rows[0] || null;
    } finally {
      client.release();
    }
  }

  async acceptFriendRequest(requestId: number): Promise<Friend> {
    const client = await this.fastify.pg.connect();
    try {
      await client.query("BEGIN");

      // Get the friend request
      const { rows: requestRows } = await client.query<FriendRequest>(
        `SELECT * FROM friend_requests WHERE id = $1`,
        [requestId]
      );
      const request = requestRows[0];

      // Create friendship
      const { rows: friendRows } = await client.query<Friend>(
        `INSERT INTO friends ("userOneId", "userTwoId", "userOneUsername", "userTwoUsername")
         VALUES ($1, $2, $3, $4)
         RETURNING *`,
        [
          request.senderId,
          request.receiverId,
          request.senderUsername,
          request.receiverUsername,
        ]
      );

      // Delete the friend request
      await client.query(`DELETE FROM friend_requests WHERE id = $1`, [
        requestId,
      ]);

      await client.query("COMMIT");
      return friendRows[0];
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async declineFriendRequest(requestId: number): Promise<void> {
    const client = await this.fastify.pg.connect();
    try {
      await client.query(`DELETE FROM friend_requests WHERE id = $1`, [
        requestId,
      ]);
    } finally {
      client.release();
    }
  }

  async cancelFriendRequest(requestId: number): Promise<void> {
    const client = await this.fastify.pg.connect();
    try {
      await client.query(`DELETE FROM friend_requests WHERE id = $1`, [
        requestId,
      ]);
    } finally {
      client.release();
    }
  }

  async deleteFriendship(userId: number, friendId: number): Promise<boolean> {
    const client = await this.fastify.pg.connect();
    try {
      const { rowCount } = await client.query(
        `DELETE FROM friends
         WHERE ("userOneId" = $1 AND "userTwoId" = $2)
         OR ("userOneId" = $2 AND "userTwoId" = $1)`,
        [userId, friendId]
      );

      return (rowCount ?? 0) > 0;
    } finally {
      client.release();
    }
  }

  /**
   * Get user by username
   */
  async getUserByUsername(username: string): Promise<{
    id: number;
    username: string;
    avatarUrl: string | null;
  } | null> {
    const client = await this.fastify.pg.connect();
    try {
      const { rows } = await client.query<{
        id: number;
        username: string;
        avatarUrl: string | null;
      }>(`SELECT id, username, "avatarUrl" FROM users WHERE username = $1`, [
        username,
      ]);

      return rows[0] || null;
    } finally {
      client.release();
    }
  }

  async getUserById(userId: number): Promise<{
    id: number;
    username: string;
    avatarUrl: string | null;
  } | null> {
    const client = await this.fastify.pg.connect();
    try {
      const { rows } = await client.query<{
        id: number;
        username: string;
        avatarUrl: string | null;
      }>(`SELECT id, username, "avatarUrl" FROM users WHERE id = $1`, [userId]);

      return rows[0] || null;
    } finally {
      client.release();
    }
  }
}
