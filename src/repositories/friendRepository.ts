import type { FastifyInstance } from "fastify";
import type {
  Friend,
  FriendRequest,
  FriendSuggestion,
  FriendListItem,
  IncomingFriendRequestResponse,
  OutgoingFriendRequestResponse,
} from "../models/Friend.js";
import {
  FriendRequestNotFoundError,
  UserNotFoundError,
} from "../errors/index.js";

/**
 * Raw database row types for query results
 */
interface FriendListItemRaw {
  id: number;
  username: string;
  avatarUrl: string | null;
  friendsSince: Date;
  blitzRating: number | null;
  bulletRating: number | null;
  rapidRating: number | null;
  total_count?: string;
}

interface FriendSuggestionRaw {
  id: number;
  username: string;
  avatarUrl: string | null;
  total_count?: string;
}

/**
 * Repository for managing friend relationships and friend requests
 */
/** Escapes LIKE wildcards so a search for "a_b" or "50%" matches literally. */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}

export class FriendRepository {
  constructor(private fastify: FastifyInstance) {}

  /**
   * Private helper: Builds the subquery to exclude existing friends
   * Returns SQL fragment for use in NOT IN or WHERE clauses
   */
  private buildExcludeFriendsSubquery(): string {
    return `
      SELECT "userTwoId" as friend_id FROM friends WHERE "userOneId" = $1
      UNION
      SELECT "userOneId" as friend_id FROM friends WHERE "userTwoId" = $1
    `;
  }

  /**
   * Private helper: Builds the CASE condition for bidirectional friend joins
   * Returns SQL fragment for use in JOIN ON clauses
   */
  private buildFriendJoinCondition(userParam: string = "$1"): string {
    return `
      CASE
        WHEN f."userOneId" = ${userParam} THEN u.id = f."userTwoId"
        WHEN f."userTwoId" = ${userParam} THEN u.id = f."userOneId"
        ELSE FALSE
      END
    `;
  }

  /**
   * Get friend suggestions for a user (paginated)
   * Excludes users who are already friends with the given user
   *
   * @param userId - The ID of the user requesting suggestions
   * @param limit - Maximum number of results to return
   * @param offset - Number of results to skip for pagination
   * @returns Object containing suggestions array and total count
   */
  async getFriendSuggestions(
    userId: number,
    limit: number,
    offset: number
  ): Promise<{ suggestions: FriendSuggestion[]; total: number }> {
    const client = this.fastify.pg;
    // Use CTE and window function for efficient single-query approach
    const { rows } = await client.query<FriendSuggestionRaw>(
      `
      WITH user_friends AS (
        ${this.buildExcludeFriendsSubquery()}
      )
      SELECT
        id,
        username,
        "avatarUrl",
        COUNT(*) OVER() as total_count
      FROM users
      WHERE id != $1
        AND "clerkId" IS NOT NULL -- deleted accounts
        AND id NOT IN (SELECT friend_id FROM user_friends)
      ORDER BY username
      LIMIT $2 OFFSET $3
      `,
      [userId, limit, offset]
    );

    const total = rows[0] ? parseInt(rows[0].total_count || "0", 10) : 0;

    const suggestions: FriendSuggestion[] = rows.map((row) => ({
      id: row.id,
      username: row.username,
      avatarUrl: row.avatarUrl,
    }));

    return { suggestions, total };
  }

  /**
   * Get user's friends list (paginated)
   * Optionally filter by username search query
   *
   * @param userId - The ID of the user whose friends to retrieve
   * @param limit - Maximum number of results to return
   * @param offset - Number of results to skip for pagination
   * @param searchQuery - Optional search string to filter friends by username
   * @returns Object containing friends array and total count
   */
  async getFriends(
    userId: number,
    limit: number,
    offset: number,
    searchQuery?: string
  ): Promise<{ friends: FriendListItem[]; total: number }> {
    const client = this.fastify.pg;
    let query: string;
    let params: (number | string)[];

    if (searchQuery) {
      const searchPattern = `%${escapeLike(searchQuery)}%`;
      // With search filter - using window function for count + data in single query
      query = `
        SELECT
          u.id,
          u.username,
          u."avatarUrl",
          f."createdAt" as "friendsSince",
          u."blitzRating",
          u."bulletRating",
          u."rapidRating",
          COUNT(*) OVER() as total_count
        FROM friends f
        INNER JOIN users u ON (${this.buildFriendJoinCondition()})
        WHERE (f."userOneId" = $1 OR f."userTwoId" = $1)
          AND u.username ILIKE $2 ESCAPE '\\'
        ORDER BY u.username
        LIMIT $3 OFFSET $4
      `;
      params = [userId, searchPattern, limit, offset];
    } else {
      // Without search filter - using window function for count + data in single query
      query = `
        SELECT
          u.id,
          u.username,
          u."avatarUrl",
          f."createdAt" as "friendsSince",
          u."blitzRating",
          u."bulletRating",
          u."rapidRating",
          COUNT(*) OVER() as total_count
        FROM friends f
        INNER JOIN users u ON (${this.buildFriendJoinCondition()})
        WHERE (f."userOneId" = $1 OR f."userTwoId" = $1)
        ORDER BY u.username
        LIMIT $2 OFFSET $3
      `;
      params = [userId, limit, offset];
    }

    const { rows } = await client.query<FriendListItemRaw>(query, params);

    const total = rows[0] ? parseInt(rows[0].total_count || "0", 10) : 0;

    const friends: FriendListItem[] = rows.map((row) => ({
      id: row.id,
      username: row.username,
      avatarUrl: row.avatarUrl,
      friendsSince: row.friendsSince,
      blitzRating: row.blitzRating,
      bulletRating: row.bulletRating,
      rapidRating: row.rapidRating,
    }));

    return { friends, total };
  }

  /**
   * Search for users by username (excluding current friends)
   * Used for finding new users to send friend requests to
   *
   * @param userId - The ID of the user performing the search
   * @param searchQuery - Search string to filter users by username
   * @param limit - Maximum number of results to return
   * @param offset - Number of results to skip for pagination
   * @returns Object containing suggestions array and total count
   */
  async searchUsers(
    userId: number,
    searchQuery: string,
    limit: number,
    offset: number
  ): Promise<{ suggestions: FriendSuggestion[]; total: number }> {
    const client = this.fastify.pg;
    const searchPattern = `%${escapeLike(searchQuery)}%`;

    // Use CTE and window function for efficient single-query approach
    const { rows } = await client.query<FriendSuggestionRaw>(
      `
      WITH user_friends AS (
        ${this.buildExcludeFriendsSubquery()}
      )
      SELECT
        id,
        username,
        "avatarUrl",
        COUNT(*) OVER() as total_count
      FROM users
      WHERE id != $1
        AND "clerkId" IS NOT NULL -- deleted accounts
        AND username ILIKE $2 ESCAPE '\\'
        AND id NOT IN (SELECT friend_id FROM user_friends)
      ORDER BY username
      LIMIT $3 OFFSET $4
      `,
      [userId, searchPattern, limit, offset]
    );

    const total = rows[0] ? parseInt(rows[0].total_count || "0", 10) : 0;

    const suggestions: FriendSuggestion[] = rows.map((row) => ({
      id: row.id,
      username: row.username,
      avatarUrl: row.avatarUrl,
    }));

    return { suggestions, total };
  }

  /**
   * Create a new friend request
   *
   * @param senderId - ID of the user sending the request
   * @param senderUsername - Username of the sender
   * @param senderAvatarUrl - Avatar URL of the sender
   * @param receiverId - ID of the user receiving the request
   * @param receiverUsername - Username of the receiver
   * @param receiverAvatarUrl - Avatar URL of the receiver
   * @returns The created friend request
   */
  async createFriendRequest(
    senderId: number,
    senderUsername: string,
    senderAvatarUrl: string | null,
    receiverId: number,
    receiverUsername: string,
    receiverAvatarUrl: string | null
  ): Promise<FriendRequest> {
    const client = this.fastify.pg;
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

    return rows[0]!;
  }

  /**
   * Get all pending friend requests for a user (both incoming and outgoing)
   *
   * @param userId - The ID of the user
   * @returns Object containing arrays of incoming and outgoing requests
   */
  async getPendingFriendRequests(userId: number): Promise<{
    incoming: IncomingFriendRequestResponse[];
    outgoing: OutgoingFriendRequestResponse[];
  }> {
    const client = this.fastify.pg;
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
  }

  /**
   * Check if a friend request exists between two users (bidirectional)
   *
   * @param senderId - ID of one user
   * @param receiverId - ID of the other user
   * @returns True if a request exists in either direction
   */
  async friendRequestExists(
    senderId: number,
    receiverId: number
  ): Promise<boolean> {
    const client = this.fastify.pg;
    const { rows } = await client.query(
      `SELECT id FROM friend_requests
       WHERE ("senderId" = $1 AND "receiverId" = $2)
       OR ("senderId" = $2 AND "receiverId" = $1)`,
      [senderId, receiverId]
    );

    return rows.length > 0;
  }

  /**
   * Check if two users are friends (bidirectional)
   *
   * @param userOneId - ID of one user
   * @param userTwoId - ID of the other user
   * @returns True if the users are friends
   */
  async areFriends(userOneId: number, userTwoId: number): Promise<boolean> {
    const client = this.fastify.pg;
    const { rows } = await client.query(
      `SELECT id FROM friends
       WHERE ("userOneId" = $1 AND "userTwoId" = $2)
       OR ("userOneId" = $2 AND "userTwoId" = $1)`,
      [userOneId, userTwoId]
    );

    return rows.length > 0;
  }

  /**
   * Get a friend request by its ID
   *
   * @param requestId - The ID of the friend request
   * @returns The friend request or null if not found
   */
  async getFriendRequestById(requestId: number): Promise<FriendRequest | null> {
    const client = this.fastify.pg;
    const { rows } = await client.query<FriendRequest>(
      `SELECT * FROM friend_requests WHERE id = $1`,
      [requestId]
    );

    return rows[0] || null;
  }

  /**
   * Accept a friend request, creating a friendship and deleting the request
   * This operation is performed within a transaction to ensure atomicity
   *
   * @param requestId - The ID of the friend request to accept
   * @returns The created friendship
   * @throws {FriendRequestNotFoundError} If the friend request doesn't exist
   */
  async acceptFriendRequest(requestId: number): Promise<Friend> {
    return this.fastify.pg.transact(async (client) => {
      // Deleting first claims the request, so two concurrent accepts can't both succeed
      const { rows: requestRows } = await client.query<FriendRequest>(
        `DELETE FROM friend_requests WHERE id = $1 RETURNING *`,
        [requestId]
      );
      const request = requestRows[0];
      if (!request) {
        throw new FriendRequestNotFoundError(
          `Friend request with ID ${requestId} not found`
        );
      }

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
      return friendRows[0]!;
    });
  }

  /**
   * Delete a friend request (can be used for both declining and canceling)
   * Decline = receiver deletes incoming request
   * Cancel = sender deletes outgoing request
   *
   * @param requestId - The ID of the friend request to delete
   */
  async deleteFriendRequest(requestId: number): Promise<void> {
    const client = this.fastify.pg;
    await client.query(`DELETE FROM friend_requests WHERE id = $1`, [
      requestId,
    ]);
  }

  /**
   * Delete a friendship between two users (bidirectional)
   *
   * @param userId - ID of one user
   * @param friendId - ID of the other user
   * @returns True if a friendship was deleted, false if no friendship existed
   */
  async deleteFriendship(userId: number, friendId: number): Promise<boolean> {
    const client = this.fastify.pg;
    // Challenges are only allowed between friends, so drop pending ones too
    const { rowCount } = await client.query(
      `WITH dropped AS (
         DELETE FROM challenges
         WHERE ("challengerId" = $1 AND "challengedId" = $2)
            OR ("challengerId" = $2 AND "challengedId" = $1)
       )
       DELETE FROM friends
       WHERE ("userOneId" = $1 AND "userTwoId" = $2)
       OR ("userOneId" = $2 AND "userTwoId" = $1)`,
      [userId, friendId]
    );

    return (rowCount ?? 0) > 0;
  }
}
