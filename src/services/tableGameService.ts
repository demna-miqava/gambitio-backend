import type { FastifyInstance } from "fastify";
import { AppError } from "../errors/AppError.js";
import { gameRepository } from "../repositories/gameRepository.js";
import { topics, type RealtimeHub } from "../realtime/hub.js";
import { getTimeControl, type PlayerColor } from "../models/common.js";
import type { GameResponse } from "../models/Game.js";
import type { EndReason, GameResult } from "../game/engine.js";
import {
  cleanGuestName,
  MAX_PENDING_TABLE_GAMES_PER_PAIR,
  replayTableGame,
  TABLE_GAMES_PER_DAY,
  type TableGameClaim,
} from "../game/tableGame.js";
import { withinLimit } from "../utils/rateLimit.js";
import { toGameResponse } from "./gameService.js";

export interface SaveTableGameInput extends TableGameClaim {
  pgn: string;
  /** The recorder's side of the board */
  color: PlayerColor;
  /** Each side's starting clock in seconds (they differ with time odds) */
  whiteTime: number;
  blackTime: number;
  increment: number;
  opponent: { kind: "guest"; name: string } | { kind: "friend"; userId: number };
  /** The browser's id for the game: saving it again returns the stored one (migration 041) */
  clientId?: string | undefined;
}

/** A friend's table game waiting for them to confirm, as their inbox shows it */
export interface TableGameRequest {
  gameId: number;
  createdAt: Date;
  from: { id: number; username: string; avatarUrl: string | null };
  /** The friend's side of the board */
  color: PlayerColor;
  time: number;
  increment: number;
  whiteTime: number | null;
  blackTime: number | null;
  result: GameResult;
  endReason: EndReason;
  numMoves: number;
}

const requestNotFound = () =>
  new AppError("That game isn't waiting for you to confirm", "TABLE_REQUEST_NOT_FOUND", 404);

/**
 * Table mode games (src/game/tableGame.ts, migration 040): stored once
 * finished, never rated. The other player is a guest (a name) or a friend,
 * whose id goes on the game only when they confirm it in their inbox.
 */
export class TableGameService {
  constructor(
    private fastify: FastifyInstance,
    private hub: RealtimeHub
  ) {}

  async save(userId: number, input: SaveTableGameInput): Promise<GameResponse> {
    const guestName = input.opponent.kind === "guest" ? cleanGuestName(input.opponent.name) : null;
    if (input.opponent.kind === "guest" && !guestName) {
      throw new AppError("Give the other player a name (up to 30 characters)", "INVALID_GUEST_NAME", 400);
    }
    const friendId = input.opponent.kind === "friend" ? input.opponent.userId : null;
    if (friendId === userId) throw new AppError("Pick someone else as the other player", "NOT_FRIENDS", 400);

    // The same game sent again (a retry after a lost answer, another tab):
    // the one stored the first time, counted against nothing. Looked up
    // again under the recorder's row lock below, for two saves at once
    const { clientId } = input;
    if (clientId !== undefined) {
      const saved = await gameRepository.findTableGameByClientId(this.fastify.pg, userId, clientId);
      if (saved) return toGameResponse(saved);
    }

    // Counted before the replay, so the cap also bounds the work spent on
    // uploads that turn out to be invalid (as for bot games)
    const allowed = await withinLimit(this.fastify.redis, `tablegames:saved:${userId}`, TABLE_GAMES_PER_DAY, 24 * 60 * 60);
    if (!allowed) {
      throw new AppError("You've saved a lot of table games today. Try again tomorrow.", "TABLE_GAME_LIMIT", 429);
    }
    const replayed = replayTableGame(input.pgn, { result: input.result, endReason: input.endReason });
    const time = Math.max(input.whiteTime, input.blackTime);
    const odds = input.whiteTime !== input.blackTime;
    const ratingColumn = `"${getTimeControl(time)}Rating"`;

    const { game, request } = await this.fastify.pg.transact(async (tx) => {
      if (clientId !== undefined) {
        // Saves by one recorder take this lock one at a time, so a save
        // with the same id that committed meanwhile is seen here
        await tx.query(`SELECT 1 FROM users WHERE id = $1 FOR UPDATE`, [userId]);
        const saved = await gameRepository.findTableGameByClientId(tx, userId, clientId);
        if (saved) return { game: saved, request: null };
      }
      // Locks the recorder's row (so their pending requests are counted one
      // save at a time) and counts the game in their history (migration 030)
      const { rows: me } = await tx.query<{ username: string; avatarUrl: string | null; rating: number }>(
        `UPDATE users SET "listedGames" = "listedGames" + 1 WHERE id = $1
         RETURNING username, "avatarUrl", ${ratingColumn} AS rating`,
        [userId]
      );
      const recorder = me[0];
      if (!recorder) throw new AppError("User not found", "USER_NOT_FOUND", 404);

      // A guest, or a friend until they confirm: a plain name (no rating,
      // avatar or id), so a game they never confirm says nothing else
      // about them
      let other = { username: guestName ?? "", rating: 0 };
      if (friendId !== null) {
        // Only a friend, with no block either way, and not a deleted account
        const { rows: friends } = await tx.query<{ username: string; pending: number }>(
          `SELECT u.username,
             (SELECT COUNT(*) FROM table_game_requests r
              WHERE r."recorderId" = $1 AND r."friendId" = u.id AND r.status = 'pending')::int AS pending
           FROM users u
           WHERE u.id = $2 AND u."clerkId" IS NOT NULL
             AND EXISTS (SELECT 1 FROM friends f
               WHERE LEAST(f."userOneId", f."userTwoId") = LEAST($1::int, $2::int)
                 AND GREATEST(f."userOneId", f."userTwoId") = GREATEST($1::int, $2::int))
             AND NOT EXISTS (SELECT 1 FROM user_blocks b
               WHERE (b."blockerId" = $1 AND b."blockedId" = $2) OR (b."blockerId" = $2 AND b."blockedId" = $1))
           FOR KEY SHARE OF u`,
          [userId, friendId]
        );
        const friend = friends[0];
        if (!friend) throw new AppError("You can only name a friend", "NOT_FRIENDS", 403);
        if (friend.pending >= MAX_PENDING_TABLE_GAMES_PER_PAIR) {
          throw new AppError(
            `${friend.username} has ${MAX_PENDING_TABLE_GAMES_PER_PAIR} of your games to confirm already. Save this one with them as a guest, or wait until they answer.`,
            "TOO_MANY_PENDING",
            409
          );
        }
        other = { username: friend.username, rating: 0 };
      }

      const isWhite = input.color === "white";
      const { result, reason } = replayed.outcome;
      const recorderWon = result === (isWhite ? "white_win" : "black_win");
      const game = await gameRepository.insertFinishedTableGame(tx, {
        // The friend's id only once they confirm
        whiteId: isWhite ? userId : null,
        blackId: isWhite ? null : userId,
        whiteUsername: isWhite ? recorder.username : other.username,
        blackUsername: isWhite ? other.username : recorder.username,
        whiteRating: isWhite ? recorder.rating : other.rating,
        blackRating: isWhite ? other.rating : recorder.rating,
        whiteAvatarUrl: isWhite ? recorder.avatarUrl : null,
        blackAvatarUrl: isWhite ? null : recorder.avatarUrl,
        time,
        increment: input.increment,
        whiteTime: odds ? input.whiteTime : null,
        blackTime: odds ? input.blackTime : null,
        pgn: replayed.pgn,
        fen: replayed.fen,
        numMoves: replayed.numMoves,
        result,
        endReason: reason,
        winnerId: recorderWon ? userId : null,
      });
      if (clientId !== undefined) await gameRepository.recordTableGameClientId(tx, userId, clientId, game.id);

      let request: TableGameRequest | null = null;
      if (friendId !== null) {
        const color: PlayerColor = isWhite ? "black" : "white";
        const { rows } = await tx.query<{ createdAt: Date }>(
          `INSERT INTO table_game_requests ("gameId", "recorderId", "friendId", color)
           VALUES ($1, $2, $3, $4) RETURNING "createdAt"`,
          [game.id, userId, friendId, color]
        );
        request = {
          gameId: game.id,
          createdAt: rows[0]!.createdAt,
          from: { id: userId, username: recorder.username, avatarUrl: recorder.avatarUrl },
          color,
          time: game.time!,
          increment: game.increment,
          whiteTime: game.whiteTime,
          blackTime: game.blackTime,
          result,
          endReason: reason,
          numMoves: game.numMoves,
        };
      }
      return { game, request };
    });

    if (request && friendId !== null) {
      await this.hub
        .publish(topics.notifications(friendId), { type: "table_game_request", data: request })
        .catch((err) => this.fastify.log.error({ err }, "Failed to publish a table game request"));
    }
    return toGameResponse(game);
  }

  /** Games waiting for this player to confirm, newest first. */
  async requests(userId: number): Promise<TableGameRequest[]> {
    const { rows } = await this.fastify.pg.query<
      Omit<TableGameRequest, "from"> & { fromId: number; fromUsername: string; fromAvatarUrl: string | null }
    >(
      `SELECT r."gameId", r."createdAt", r.color, g.time, g.increment, g."whiteTime", g."blackTime",
         g.result, g."endReason", g."numMoves",
         u.id AS "fromId", u.username AS "fromUsername", u."avatarUrl" AS "fromAvatarUrl"
       FROM table_game_requests r
       JOIN games g ON g.id = r."gameId"
       JOIN users u ON u.id = r."recorderId"
       WHERE r."friendId" = $1 AND r.status = 'pending'
       ORDER BY r."createdAt" DESC
       LIMIT 50`,
      [userId]
    );
    return rows.map(({ fromId, fromUsername, fromAvatarUrl, ...request }) => ({
      ...request,
      from: { id: fromId, username: fromUsername, avatarUrl: fromAvatarUrl },
    }));
  }

  /**
   * The friend confirms: their id goes on their side of the game, which then
   * shows in their history, with their avatar and their rating for the
   * game's time control as they are now (until then it was a plain name).
   * Refused if a block came between the two since.
   */
  async confirm(userId: number, gameId: number): Promise<void> {
    const recorderId = await this.fastify.pg.transact(async (tx) => {
      const { rows } = await tx.query<{ recorderId: number; color: PlayerColor; time: number }>(
        `SELECT r."recorderId", r.color, g.time FROM table_game_requests r
         JOIN games g ON g.id = r."gameId"
         WHERE r."gameId" = $1 AND r."friendId" = $2 AND r.status = 'pending'
           AND NOT EXISTS (SELECT 1 FROM user_blocks b
             WHERE (b."blockerId" = r."recorderId" AND b."blockedId" = $2)
                OR (b."blockerId" = $2 AND b."blockedId" = r."recorderId"))
         FOR UPDATE OF r`,
        [gameId, userId]
      );
      const request = rows[0];
      if (!request) throw requestNotFound();
      // Their name, avatar and rating as they are now; counted in their history
      const ratingColumn = `"${getTimeControl(request.time)}Rating"`;
      const { rows: me } = await tx.query<{ username: string; avatarUrl: string | null; rating: number }>(
        `UPDATE users SET "listedGames" = "listedGames" + 1 WHERE id = $1
         RETURNING username, "avatarUrl", ${ratingColumn} AS rating`,
        [userId]
      );
      const side = request.color === "white" ? "white" : "black";
      await tx.query(
        `UPDATE games SET "${side}Id" = $2, "${side}Username" = $3, "${side}AvatarUrl" = $4, "${side}Rating" = $5,
           "winnerId" = CASE WHEN result = '${side}_win' THEN $2 ELSE "winnerId" END
         WHERE id = $1 AND "tableGame" AND "${side}Id" IS NULL`,
        [gameId, userId, me[0]!.username, me[0]!.avatarUrl, me[0]!.rating]
      );
      await tx.query(`DELETE FROM table_game_requests WHERE "gameId" = $1`, [gameId]);
      return request.recorderId;
    });
    await this.announce(userId, recorderId, gameId, true);
  }

  /**
   * The friend declines: the game stays the recorder's, with only their name
   * on the other side, as a guest's would be (nothing else about them was
   * put on it). A block declines the same way (ModerationService.block).
   */
  async decline(userId: number, gameId: number): Promise<void> {
    const { rows } = await this.fastify.pg.query<{ recorderId: number }>(
      `UPDATE table_game_requests SET status = 'declined'
       WHERE "gameId" = $1 AND "friendId" = $2 AND status = 'pending'
       RETURNING "recorderId"`,
      [gameId, userId]
    );
    if (!rows[0]) throw requestNotFound();
    await this.announce(userId, rows[0].recorderId, gameId, false);
  }

  /** Both players' other tabs: the request is answered (the inbox and history refresh). */
  private async announce(friendId: number, recorderId: number, gameId: number, confirmed: boolean) {
    const message = { type: "table_game_answered", data: { gameId, confirmed } };
    for (const id of [friendId, recorderId]) {
      await this.hub
        .publish(topics.notifications(id), message)
        .catch((err) => this.fastify.log.error({ err }, "Failed to publish a table game answer"));
    }
  }
}
