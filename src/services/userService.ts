import type { FastifyInstance } from "fastify";
import type { UserResponse, SyncUserRequest } from "../models/User.js";
import { UserRepository } from "../repositories/userRepository.js";
import { getRatingsBySkill } from "../utils/ratingHelpers.js";
import { AppError } from "../errors/AppError.js";
import { isUniqueViolation, type TxClient } from "../db.js";
import { gameRepository } from "../repositories/gameRepository.js";

/**
 * `batchSize`: games rewritten per statement when an account is deleted,
 * small enough that one batch takes a few milliseconds and never nears the
 * statement timeout, however many games the account played. Mutable so
 * tests can make it small.
 */
export const accountDeletion = { batchSize: 1_000 };

export class UserService {
  private userRepository: UserRepository;

  constructor(private fastify: FastifyInstance) {
    this.userRepository = new UserRepository(fastify);
  }

  async getUserById(id: number): Promise<UserResponse | null> {
    return this.userRepository.findById(id);
  }

  async getUserByClerkId(clerkId: string): Promise<UserResponse | null> {
    return this.userRepository.findByClerkId(clerkId);
  }

  /**
   * Creates the local profile for a Clerk user (idempotent). The user row and
   * default settings are created together; the unique index on
   * lower(username) settles races between two sign-ups picking the same name.
   * The email is fetched from Clerk (an API call) only when the profile
   * doesn't exist yet, so repeating the request never reaches Clerk.
   */
  async syncUser(clerkId: string, syncData: SyncUserRequest): Promise<UserResponse> {
    const existingUser = await this.userRepository.findByClerkId(clerkId);
    if (existingUser) return existingUser;
    // A name already taken fails here, before the Clerk call (the unique
    // index below still settles a race for a name that was free just now)
    if (await this.userRepository.findByUsername(syncData.username)) {
      throw new AppError("Username already taken", "USERNAME_TAKEN", 409);
    }

    const email = await this.fastify.authProvider.getEmail(clerkId);
    if (!email) throw new AppError("Email not found for user", "EMAIL_NOT_FOUND", 400);

    const rating = getRatingsBySkill(syncData.skill);
    try {
      return await this.fastify.pg.transact(async (tx) => {
        const user = await this.userRepository.create(tx, {
          clerkId,
          email,
          username: syncData.username,
          rapidRating: rating,
          blitzRating: rating,
          bulletRating: rating,
          highestRapidRating: rating,
          highestBlitzRating: rating,
          highestBulletRating: rating,
        });
        await tx.query(`INSERT INTO user_settings ("userId") VALUES ($1)`, [user.id]);
        return user;
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        // Same Clerk user syncing twice at once: return the winner's row
        const created = await this.userRepository.findByClerkId(clerkId);
        if (created) return created;
        throw new AppError("Username already taken", "USERNAME_TAKEN", 409);
      }
      throw error;
    }
  }

  /**
   * Deletes an account. Games stay (they are the opponents' history too), but
   * the profile is anonymized and everything else personal is removed. A live
   * game is resigned (or aborted, before both players moved) first.
   *
   * In three steps, so a failure at any point leaves either nothing changed
   * or a profile a retry can find (by its Clerk id) and finish:
   * 1. One transaction removes everything personal and renames the profile,
   *    but keeps its Clerk id. A game that started meanwhile (IN_GAME)
   *    rolls it all back.
   * 2. Their name comes off their past games in bounded batches, so a long
   *    history can't run into the statement timeout. Games created from
   *    here on copy the renamed profile (createGame reads it).
   * 3. A last short transaction clears what the account added while the
   *    batches ran and then the Clerk id.
   * The Clerk user is deleted last; if that fails the client can retry,
   * because this also works once the profile is already gone.
   */
  async deleteAccount(clerkId: string): Promise<void> {
    const user = await this.userRepository.findByClerkId(clerkId);
    if (user) {
      const gameId = await gameRepository.findActiveGameIdForUser(this.fastify.pg, user.id);
      if (gameId !== null) {
        const game = await gameRepository.findById(this.fastify.pg, gameId);
        await (game && game.numMoves < 2
          ? this.fastify.liveGames.abort(gameId, user.id)
          : this.fastify.liveGames.resign(gameId, user.id)
        ).catch((error) => {
          // Ended on its own in the meantime
          if (!(error instanceof AppError && error.code === "GAME_OVER")) throw error;
        });
      }

      const deletedRooms = await this.fastify.pg.transact((tx) => this.removePersonalData(tx, user.id));
      // Members still in the deleted rooms stop listening
      for (const roomId of deletedRooms) await this.fastify.study.closeRoomSockets(roomId);

      await this.anonymizeGames(user.id, "white");
      await this.anonymizeGames(user.id, "black");

      const lateRooms = await this.fastify.pg.transact(async (tx) => {
        const rooms = await this.removePersonalData(tx, user.id);
        await tx.query(`UPDATE users SET "clerkId" = NULL WHERE id = $1`, [user.id]);
        return rooms;
      });
      for (const roomId of lateRooms) await this.fastify.study.closeRoomSockets(roomId);
    }
    this.fastify.users.forget(clerkId);
    // Open sockets were authenticated before; close them on every instance
    if (user) await this.fastify.hub.closeUserSockets(user.id).catch(() => {});
    await this.fastify.authProvider.deleteUser(clerkId);
  }

  /**
   * Removes everything personal of a user being deleted and renames the
   * profile, inside the caller's transaction; the Clerk id stays. Throws
   * IN_GAME if a game started since the caller resigned theirs. Safe to run
   * again (deleteAccount runs it twice). Returns the study rooms it deleted.
   */
  private async removePersonalData(tx: TxClient, userId: number): Promise<number[]> {
    // Their unfinished series go to the opponent. Before the user lock:
    // series rows are always locked before players' rows
    await tx.query(
      `UPDATE series SET status = 'finished', "endReason" = 'resignation', "endedAt" = now(),
         "winnerId" = CASE WHEN "playerOneId" = $1 THEN "playerTwoId" ELSE "playerOneId" END
       WHERE status = 'active' AND ("playerOneId" = $1 OR "playerTwoId" = $1)`,
      [userId]
    );
    const id = [userId];
    // Also before the user lock: pairing, accepting a challenge and a
    // rematch all take queue rows first and the players after (in
    // createGame), so taking them in the other order deadlocked. A
    // pairing already under way finishes first and is caught by the
    // active-game check below.
    await tx.query(`DELETE FROM matchmaking WHERE "userId" = $1`, id);
    // Same lock createGame takes, so no new game can start meanwhile
    await tx.query(`SELECT 1 FROM users WHERE id = $1 FOR UPDATE`, id);
    if ((await gameRepository.findActiveGameIdForUser(tx, userId)) !== null) {
      throw new AppError("A game started while deleting; try again", "IN_GAME", 409);
    }
    // After the user lock: accepting a challenge locks the players, then
    // takes the challenge row
    await tx.query(`DELETE FROM challenges WHERE "challengerId" = $1 OR "challengedId" = $1`, id);
    await tx.query(`DELETE FROM friends WHERE "userOneId" = $1 OR "userTwoId" = $1`, id);
    await tx.query(`DELETE FROM friend_requests WHERE "senderId" = $1 OR "receiverId" = $1`, id);
    await tx.query(`DELETE FROM user_blocks WHERE "blockerId" = $1 OR "blockedId" = $1`, id);
    await tx.query(`DELETE FROM user_settings WHERE "userId" = $1`, id);
    await tx.query(`DELETE FROM solved_puzzles WHERE "userId" = $1`, id);
    await tx.query(`DELETE FROM puzzle_attempts WHERE "userId" = $1`, id);
    await tx.query(`DELETE FROM repertoire_lines WHERE "userId" = $1`, id);
    await tx.query(`DELETE FROM endgame_progress WHERE "userId" = $1`, id);
    await tx.query(`DELETE FROM game_chat_messages WHERE "senderId" = $1`, id);
    await tx.query(`DELETE FROM push_subscriptions WHERE "userId" = $1`, id);
    // Rooms they own go (with everyone's membership); they leave the others
    const { rows: rooms } = await tx.query<{ id: number }>(
      `DELETE FROM study_rooms WHERE "ownerId" = $1 RETURNING id`,
      id
    );
    await tx.query(`DELETE FROM study_room_members WHERE "userId" = $1`, id);
    // "deleted-" can't clash with a real name: usernames can't contain "-"
    await tx.query(
      `UPDATE users SET email = NULL, "avatarUrl" = NULL, username = 'deleted-' || id WHERE id = $1`,
      id
    );
    return rooms.map((r) => r.id);
  }

  /**
   * Replaces a deleted user's name and avatar on their games, newest first,
   * accountDeletion.batchSize rows per statement (each its own short transaction),
   * walking the ("<side>Id", "createdAt" DESC) index with a cursor so every
   * batch reads about as many rows as it writes. Rows already done are
   * skipped, so it can be run again after a failure, and a batch that ends
   * between rows with the same timestamp still moves on.
   */
  private async anonymizeGames(userId: number, side: "white" | "black"): Promise<void> {
    const size = accountDeletion.batchSize;
    const pending = `("${side}Username" IS DISTINCT FROM 'deleted-' || "${side}Id" OR "${side}AvatarUrl" IS NOT NULL)`;
    const batch = (where: string) => `
      WITH batch AS (
        SELECT id FROM games
        WHERE "${side}Id" = $1 AND ${where} AND ${pending}
        ORDER BY "createdAt" DESC
        LIMIT ${size}
      ), done AS (
        UPDATE games g SET "${side}Username" = 'deleted-' || g."${side}Id", "${side}AvatarUrl" = NULL
        FROM batch WHERE g.id = batch.id
        RETURNING g."createdAt"
      )
      SELECT count(*)::int AS n, min("createdAt")::text AS oldest FROM done`;

    // The cursor stays a timestamptz end to end: its text keeps the UTC
    // offset (and the microseconds a Date would drop), whatever the
    // session's time zone

    let cursor = "infinity";
    for (;;) {
      const { rows } = await this.fastify.pg.query<{ n: number; oldest: string | null }>(
        batch(`"createdAt" <= $2::timestamptz`),
        [userId, cursor]
      );
      if (rows[0]!.n < size) break;
      cursor = rows[0]!.oldest!;
    }
    // Rows without a timestamp (none are written today, but the column allows it)
    for (;;) {
      const { rows } = await this.fastify.pg.query<{ n: number }>(batch(`"createdAt" IS NULL`), [userId]);
      if (rows[0]!.n < size) break;
    }
  }

  async isUsernameAvailable(username: string): Promise<boolean> {
    return !(await this.userRepository.findByUsername(username));
  }
}
