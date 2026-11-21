import type { FastifyInstance } from "fastify";
import type { Queryable } from "../db.js";
import { UserNotFoundError } from "../errors/FriendErrors.js";
import { blocksBetween, notBlockedSql } from "./blockRepository.js";
import type {
  Friend,
  FriendRequest,
  FriendSuggestion,
  FriendListItem,
  IncomingFriendRequestResponse,
  OutgoingFriendRequestResponse,
} from "../models/Friend.js";

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

/**
 * Repository for managing friend relationships and friend requests
 */
/** Escapes LIKE wildcards so a search for "a_b" or "50%" matches literally. */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/**
 * Inside a transaction: locks both users' rows (FOR SHARE, lowest id first)
 * and says whether the two can be friends: both accounts still there, and no
 * block either way. Blocking (ModerationService.block) and deleting an
 * account (UserService.removePersonalData) lock these rows in modes that
 * conflict with FOR SHARE, so neither can run between this check and the
 * caller's write; one that ran first is seen here, and one that comes after
 * sees what the caller wrote and removes it.
 */
async function lockPair(db: Queryable, first: number, second: number): Promise<"ok" | "gone" | "blocked"> {
  const { rows } = await db.query(
    `SELECT id FROM users WHERE id = ANY($1::int[]) AND "clerkId" IS NOT NULL ORDER BY id FOR SHARE`,
    [[first, second]]
  );
  if (rows.length < 2) return "gone";
  const blocks = await blocksBetween(db, first, second);
  return blocks.byFirst || blocks.bySecond ? "blocked" : "ok";
}

export class FriendRepository {
  constructor(private fastify: FastifyInstance) {}

  /**
   * How many friends the user has (whose username contains `searchQuery`,
   * if given): the total for a page past the last one, which has no rows
   * to carry the count.
   */
  private async countFriends(userId: number, searchQuery?: string): Promise<number> {
    const { rows } = await this.fastify.pg.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n
       FROM friends f
       INNER JOIN users u ON (${this.buildFriendJoinCondition()})
       WHERE (f."userOneId" = $1 OR f."userTwoId" = $1)
         AND ($2::text IS NULL OR u.username ILIKE $2 ESCAPE '\\')`,
      [userId, searchQuery ? `%${escapeLike(searchQuery)}%` : null]
    );
    return rows[0]!.n;
  }

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
   * Join condition from a friends row to the *other* user. It must stay in
   * the form `u.id = <expression of f>`: that lets Postgres look the friend
   * up by primary key. A CASE around the whole comparison instead makes it
   * compare every user against every friendship row.
   */
  private buildFriendJoinCondition(userParam: string = "$1"): string {
    return `u.id = CASE WHEN f."userOneId" = ${userParam} THEN f."userTwoId" ELSE f."userOneId" END`;
  }

  /**
   * A few users to suggest, starting at a random point in the id range (so
   * different people see different suggestions) and wrapping around. Not
   * the user, not deleted accounts, not existing friends, and nobody on
   * either side of a block. Each half is a
   * primary-key range scan that stops after `limit` rows.
   */
  async getFriendSuggestions(userId: number, limit: number): Promise<FriendSuggestion[]> {
    const pick = (range: string) => `(
        SELECT id, username, "avatarUrl" FROM users
        WHERE ${range} AND id <> $1 AND "clerkId" IS NOT NULL -- deleted accounts
          AND id NOT IN (SELECT friend_id FROM user_friends)
          AND ${notBlockedSql("$1", "users.id")}
        ORDER BY id LIMIT $2)`;
    const { rows } = await this.fastify.pg.query<FriendSuggestion>(
      `
      WITH user_friends AS (
        ${this.buildExcludeFriendsSubquery()}
      ), start AS (
        SELECT floor(random() * (COALESCE((SELECT max(id) FROM users), 0) + 1))::int AS id
      )
      ${pick(`id >= (SELECT id FROM start)`)}
      UNION ALL
      ${pick(`id < (SELECT id FROM start)`)}
      LIMIT $2
      `,
      [userId, limit]
    );
    return rows.map((row) => ({ id: row.id, username: row.username, avatarUrl: row.avatarUrl }));
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

    const total = rows[0]
      ? parseInt(rows[0].total_count || "0", 10)
      : offset > 0
        ? await this.countFriends(userId, searchQuery)
        : 0;

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
   * Users whose name contains the query (starts with it, for queries under
   * three characters), excluding the user, their friends and players they
   * have blocked, A to Z. Both forms can use the trigram index on username
   * (migration 014).
   *
   * Someone who blocked the user still shows up: the user can find them on
   * their profile or in old games anyway, so leaving them out of search
   * would tell the user they were blocked. A friend request to them is
   * refused like a cooldown (FriendService), which says nothing either.
   */
  async searchUsers(userId: number, searchQuery: string, limit: number): Promise<FriendSuggestion[]> {
    const escaped = escapeLike(searchQuery);
    const searchPattern = searchQuery.length < 3 ? `${escaped}%` : `%${escaped}%`;
    const { rows } = await this.fastify.pg.query<FriendSuggestion>(
      `
      WITH user_friends AS (
        ${this.buildExcludeFriendsSubquery()}
      )
      SELECT id, username, "avatarUrl"
      FROM users
      WHERE id != $1
        AND "clerkId" IS NOT NULL -- deleted accounts
        AND username ILIKE $2 ESCAPE '\\'
        AND id NOT IN (SELECT friend_id FROM user_friends)
        AND NOT EXISTS (SELECT 1 FROM user_blocks ub WHERE ub."blockerId" = $1 AND ub."blockedId" = users.id)
      -- lower(username) is the unique index's order: for a common prefix
      -- Postgres walks it and stops after $3 matches, for a rare one it uses
      -- the trigram index and sorts the few matches
      ORDER BY lower(username)
      LIMIT $3
      `,
      [userId, searchPattern, limit]
    );
    return rows.map((row) => ({ id: row.id, username: row.username, avatarUrl: row.avatarUrl }));
  }

  /**
   * Everything sending a request depends on, in one round trip: the
   * receiver (not a deleted account), the sender's avatar, and whether the
   * two are already friends or have a request pending in either direction.
   */
  async getRequestContext(senderId: number, receiverId: number): Promise<{
    receiver: { id: number; username: string; avatarUrl: string | null } | null;
    senderAvatarUrl: string | null;
    areFriends: boolean;
    requestExists: boolean;
  }> {
    const { rows } = await this.fastify.pg.query<{
      receiverId: number | null;
      receiverUsername: string | null;
      receiverAvatarUrl: string | null;
      senderAvatarUrl: string | null;
      areFriends: boolean;
      requestExists: boolean;
    }>(
      `SELECT r.id AS "receiverId", r.username AS "receiverUsername", r."avatarUrl" AS "receiverAvatarUrl",
         (SELECT "avatarUrl" FROM users WHERE id = $1) AS "senderAvatarUrl",
         EXISTS (SELECT 1 FROM friends
                 WHERE ("userOneId" = $1 AND "userTwoId" = $2) OR ("userOneId" = $2 AND "userTwoId" = $1))
           AS "areFriends",
         EXISTS (SELECT 1 FROM friend_requests
                 WHERE ("senderId" = $1 AND "receiverId" = $2) OR ("senderId" = $2 AND "receiverId" = $1))
           AS "requestExists"
       FROM (SELECT 1) one
       LEFT JOIN users r ON r.id = $2 AND r."clerkId" IS NOT NULL`,
      [senderId, receiverId]
    );
    const row = rows[0]!;
    return {
      receiver:
        row.receiverId === null
          ? null
          : { id: row.receiverId, username: row.receiverUsername!, avatarUrl: row.receiverAvatarUrl },
      senderAvatarUrl: row.senderAvatarUrl,
      areFriends: row.areFriends,
      requestExists: row.requestExists,
    };
  }

  /**
   * Creates a friend request. Returns null if one already exists between the
   * two users in either direction: the unique index on the unordered pair
   * (migration 014) settles two users requesting each other at once. Also
   * null if a block between them came in after the caller's checks (the
   * caller's "already exists" doesn't reveal it); throws UserNotFoundError
   * if either account was deleted meanwhile (see lockPair).
   */
  async createFriendRequest(
    senderId: number,
    senderUsername: string,
    senderAvatarUrl: string | null,
    receiverId: number,
    receiverUsername: string,
    receiverAvatarUrl: string | null
  ): Promise<FriendRequest | null> {
    return this.fastify.pg.transact(async (client) => {
      const pair = await lockPair(client, senderId, receiverId);
      if (pair === "gone") throw new UserNotFoundError(`User with ID ${receiverId} not found`);
      if (pair === "blocked") return null;
      const { rows } = await client.query<FriendRequest>(
        `INSERT INTO friend_requests (
          "senderId", "receiverId", "senderUsername", "receiverUsername",
          "senderAvatarUrl", "receiverAvatarUrl"
        ) VALUES ($1, $2, $3, $4, $5, $6)
        ON CONFLICT DO NOTHING
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
      return rows[0] ?? null;
    });
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
   * Accepts a request addressed to `receiverId`: deletes it and creates the
   * friendship in one transaction. Deleting first claims the request, so two
   * concurrent accepts can't both succeed. Returns null if there is no such
   * request for this receiver (the caller works out which error applies).
   * A request left between players who can't be friends any more (a block,
   * a deleted account: see lockPair) is deleted and null returned too.
   */
  async acceptFriendRequest(requestId: number, receiverId: number): Promise<Friend | null> {
    return this.fastify.pg.transact(async (client) => {
      const { rows: found } = await client.query<{ senderId: number }>(
        `SELECT "senderId" FROM friend_requests WHERE id = $1 AND "receiverId" = $2`,
        [requestId, receiverId]
      );
      if (!found[0]) return null;
      const pair = await lockPair(client, found[0].senderId, receiverId);
      const { rows: requestRows } = await client.query<FriendRequest>(
        `DELETE FROM friend_requests WHERE id = $1 AND "receiverId" = $2 RETURNING *`,
        [requestId, receiverId]
      );
      const request = requestRows[0];
      if (!request || pair !== "ok") return null;

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
   * Deletes a request if `userId` is on the given side of it (the receiver
   * declines, the sender cancels). Returns the deleted request's two users,
   * or null if nothing was deleted.
   */
  async deleteFriendRequestAs(
    requestId: number,
    userId: number,
    side: "senderId" | "receiverId"
  ): Promise<Pick<FriendRequest, "senderId" | "receiverId"> | null> {
    const { rows } = await this.fastify.pg.query<Pick<FriendRequest, "senderId" | "receiverId">>(
      `DELETE FROM friend_requests WHERE id = $1 AND "${side}" = $2 RETURNING "senderId", "receiverId"`,
      [requestId, userId]
    );
    return rows[0] ?? null;
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
    // Pending challenges between them go too, but only with a friendship:
    // two players who aren't friends keep theirs (strangers may challenge)
    const { rows } = await client.query<{ n: number }>(
      `WITH unfriended AS (
         DELETE FROM friends
         WHERE ("userOneId" = $1 AND "userTwoId" = $2)
         OR ("userOneId" = $2 AND "userTwoId" = $1)
         RETURNING 1
       ), dropped AS (
         DELETE FROM challenges
         WHERE (("challengerId" = $1 AND "challengedId" = $2)
             OR ("challengerId" = $2 AND "challengedId" = $1))
           AND EXISTS (SELECT 1 FROM unfriended)
       )
       SELECT COUNT(*)::int AS n FROM unfriended`,
      [userId, friendId]
    );

    return rows[0]!.n > 0;
  }

  /**
   * The user's first `limit` friends in the friends list's order (username,
   * then id), with the live game each has in progress (if any): what the
   * friends status list needs besides presence. The friends are picked
   * first, so only those get the game lookup, through the partial indexes
   * on live games (migration 014), one per friend.
   */
  async getFriendsWithLiveGame(userId: number, limit: number): Promise<FriendWithLiveGame[]> {
    const { rows } = await this.fastify.pg.query<FriendWithLiveGame>(
      `SELECT fu.*, g.id AS "gameId", g.time AS "gameTime"
       FROM (
         SELECT u.id, u.username, u."avatarUrl", f."createdAt" AS "friendsSince",
                u."blitzRating", u."bulletRating", u."rapidRating"
         FROM friends f
         INNER JOIN users u ON (${this.buildFriendJoinCondition()})
         WHERE f."userOneId" = $1 OR f."userTwoId" = $1
         ORDER BY u.username, u.id
         LIMIT $2
       ) fu
       LEFT JOIN LATERAL (
         SELECT id, time FROM games
         WHERE status = 'in_progress' AND ("whiteId" = fu.id OR "blackId" = fu.id)
         LIMIT 1
       ) g ON true
       ORDER BY fu.username, fu.id`,
      [userId, limit]
    );
    return rows;
  }

  /**
   * A page of the user's friends in the order you'd pick an opponent:
   * `firstIds` (friends who are online and free) first, then `nextIds`
   * (friends in a game), then whoever the user played most recently, then
   * by username. Optionally only those whose username contains
   * `searchQuery`.
   *
   * "Played recently" looks at the user's last RECENT_GAMES_PER_COLOR games
   * with each colour, read from the per-player indexes, so the lookup costs
   * the same however many games or friends the user has. A friend last
   * played before those sorts by username with the rest.
   */
  async getOpponents(
    userId: number,
    { firstIds, nextIds, limit, offset, searchQuery }: {
      firstIds: number[];
      nextIds: number[];
      limit: number;
      offset: number;
      searchQuery?: string | undefined;
    }
  ): Promise<{ friends: FriendOpponentRow[]; total: number }> {
    const params: (number | string | number[])[] = [userId, RECENT_GAMES_PER_COLOR, firstIds, nextIds, limit, offset];
    let search = "";
    if (searchQuery) {
      params.push(`%${escapeLike(searchQuery)}%`);
      search = `AND u.username ILIKE $${params.length} ESCAPE '\\'`;
    }
    const { rows } = await this.fastify.pg.query<FriendOpponentRow & { total_count: string }>(
      `WITH recent AS (
         SELECT opponent, max("createdAt") AS "lastPlayedAt"
         FROM (
           (SELECT "blackId" AS opponent, "createdAt" FROM games
            WHERE "whiteId" = $1 ORDER BY "createdAt" DESC LIMIT $2)
           UNION ALL
           (SELECT "whiteId" AS opponent, "createdAt" FROM games
            WHERE "blackId" = $1 ORDER BY "createdAt" DESC LIMIT $2)
         ) played
         WHERE opponent IS NOT NULL -- games against the computer
         GROUP BY opponent
       )
       SELECT u.id, u.username, u."avatarUrl", f."createdAt" AS "friendsSince",
              u."blitzRating", u."bulletRating", u."rapidRating",
              r."lastPlayedAt", COUNT(*) OVER() AS total_count
       FROM friends f
       INNER JOIN users u ON (${this.buildFriendJoinCondition()})
       LEFT JOIN recent r ON r.opponent = u.id
       WHERE (f."userOneId" = $1 OR f."userTwoId" = $1) ${search}
       ORDER BY CASE WHEN u.id = ANY($3::int[]) THEN 0 WHEN u.id = ANY($4::int[]) THEN 1 ELSE 2 END,
                r."lastPlayedAt" DESC NULLS LAST, u.username, u.id
       LIMIT $5 OFFSET $6`,
      params
    );
    return {
      total: rows[0]
        ? parseInt(rows[0].total_count, 10)
        : offset > 0
          ? await this.countFriends(userId, searchQuery)
          : 0,
      friends: rows.map(({ total_count: _, ...friend }) => friend),
    };
  }
}

/** How far back "played recently" looks: this many of the user's games with each colour */
const RECENT_GAMES_PER_COLOR = 100;

/** A friends list item, with when the user last played them (null: not recently, or never) */
export interface FriendOpponentRow {
  id: number;
  username: string;
  avatarUrl: string | null;
  friendsSince: Date;
  blitzRating: number | null;
  bulletRating: number | null;
  rapidRating: number | null;
  lastPlayedAt: Date | null;
}

export interface FriendWithLiveGame {
  id: number;
  username: string;
  avatarUrl: string | null;
  friendsSince: Date;
  blitzRating: number | null;
  bulletRating: number | null;
  rapidRating: number | null;
  gameId: number | null;
  /** The game's starting clock (seconds), for its time control */
  gameTime: number | null;
}
