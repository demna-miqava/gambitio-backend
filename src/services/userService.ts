import type { FastifyInstance } from "fastify";
import type { UserResponse, SyncUserRequest } from "../models/User.js";
import { UserRepository } from "../repositories/userRepository.js";
import { getRatingsBySkill } from "../utils/ratingHelpers.js";
import { AppError } from "../errors/AppError.js";
import { isUniqueViolation } from "../db.js";
import { gameRepository } from "../repositories/gameRepository.js";

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
   */
  async syncUser(clerkId: string, email: string, syncData: SyncUserRequest): Promise<UserResponse> {
    const existingUser = await this.userRepository.findByClerkId(clerkId);
    if (existingUser) return existingUser;

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
   * game is resigned (or aborted, before both players moved) first. The Clerk
   * user is deleted last; if that fails the client can retry, because this
   * also works once the profile is already gone.
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

      const deletedRooms = await this.fastify.pg.transact(async (tx) => {
        // Their unfinished series go to the opponent. Before the user lock:
        // series rows are always locked before players' rows
        await tx.query(
          `UPDATE series SET status = 'finished', "endReason" = 'resignation', "endedAt" = now(),
             "winnerId" = CASE WHEN "playerOneId" = $1 THEN "playerTwoId" ELSE "playerOneId" END
           WHERE status = 'active' AND ("playerOneId" = $1 OR "playerTwoId" = $1)`,
          [user.id]
        );
        const id = [user.id];
        // Also before the user lock: pairing, accepting a challenge and a
        // rematch all take queue rows first and the players after (in
        // createGame), so taking them in the other order deadlocked. A
        // pairing already under way finishes first and is caught by the
        // active-game check below.
        await tx.query(`DELETE FROM matchmaking WHERE "userId" = $1`, id);
        // Same lock createGame takes, so no new game can start meanwhile
        await tx.query(`SELECT 1 FROM users WHERE id = $1 FOR UPDATE`, [user.id]);
        if ((await gameRepository.findActiveGameIdForUser(tx, user.id)) !== null) {
          throw new AppError("A game started while deleting; try again", "IN_GAME", 409);
        }
        // After the user lock: accepting a challenge locks the players, then
        // takes the challenge row
        await tx.query(`DELETE FROM challenges WHERE "challengerId" = $1 OR "challengedId" = $1`, id);
        await tx.query(`DELETE FROM friends WHERE "userOneId" = $1 OR "userTwoId" = $1`, id);
        await tx.query(`DELETE FROM friend_requests WHERE "senderId" = $1 OR "receiverId" = $1`, id);
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
          `UPDATE users SET "clerkId" = NULL, email = NULL, "avatarUrl" = NULL,
             username = 'deleted-' || id
           WHERE id = $1`,
          id
        );
        await tx.query(
          `UPDATE games SET "whiteUsername" = 'deleted-' || "whiteId", "whiteAvatarUrl" = NULL
           WHERE "whiteId" = $1`,
          id
        );
        await tx.query(
          `UPDATE games SET "blackUsername" = 'deleted-' || "blackId", "blackAvatarUrl" = NULL
           WHERE "blackId" = $1`,
          id
        );
        return rooms.map((r) => r.id);
      });
      // Members still in the deleted rooms stop listening
      for (const roomId of deletedRooms) await this.fastify.study.closeRoomSockets(roomId);
    }
    this.fastify.users.forget(clerkId);
    // Open sockets were authenticated before; close them on every instance
    if (user) await this.fastify.hub.closeUserSockets(user.id).catch(() => {});
    await this.fastify.authProvider.deleteUser(clerkId);
  }

  async isUsernameAvailable(username: string): Promise<boolean> {
    return !(await this.userRepository.findByUsername(username));
  }
}
