import type { Queryable } from "../db.js";
import type { Game, LiveGame } from "../models/Game.js";
import type { EndReason, GameResult } from "../game/engine.js";

const GAME_COLUMNS = `
  id, "createdAt", pgn, fen, "winnerId", "numMoves", "whiteRating", "blackRating",
  time, increment, "whiteId", "blackId", "whiteUsername", "blackUsername",
  "whiteAvatarUrl", "blackAvatarUrl", status, result, "endReason", "endedAt",
  "whiteTimeLeftMs", "blackTimeLeftMs", "lastMoveAt", "deadlineAt",
  "drawOfferedBy", "rematchRequestedBy", "rematchGameId",
  "whiteRatingChange", "blackRatingChange", "botId", rated`;

export interface NewGame {
  whiteId: number;
  blackId: number;
  whiteUsername: string;
  blackUsername: string;
  whiteRating: number;
  blackRating: number;
  whiteAvatarUrl: string | null;
  blackAvatarUrl: string | null;
  time: number;
  increment: number;
  lastMoveAt: Date;
  deadlineAt: Date;
}

/** A finished game against a computer bot; one side is the bot (no user id). */
export interface NewBotGame {
  botId: string;
  whiteId: number | null;
  blackId: number | null;
  whiteUsername: string;
  blackUsername: string;
  whiteRating: number;
  blackRating: number;
  whiteAvatarUrl: string | null;
  blackAvatarUrl: string | null;
  pgn: string;
  fen: string;
  numMoves: number;
  result: GameResult;
  endReason: EndReason;
  winnerId: number | null;
}

/**
 * Data access for games. Every method takes the connection to use, so callers
 * decide whether it runs inside a transaction.
 */
export const gameRepository = {
  async findById(db: Queryable, gameId: number): Promise<Game | null> {
    const { rows } = await db.query<Game>(
      `SELECT ${GAME_COLUMNS} FROM games WHERE id = $1`,
      [gameId]
    );
    return rows[0] ?? null;
  },

  /** Locks the row for the rest of the transaction; all game state changes go through this. */
  async lockById(db: Queryable, gameId: number): Promise<Game | null> {
    const { rows } = await db.query<Game>(
      `SELECT ${GAME_COLUMNS} FROM games WHERE id = $1 FOR UPDATE`,
      [gameId]
    );
    return rows[0] ?? null;
  },

  async insert(db: Queryable, game: NewGame): Promise<LiveGame> {
    const { rows } = await db.query<LiveGame>(
      `INSERT INTO games (
        "whiteId", "blackId", "whiteUsername", "blackUsername",
        "whiteRating", "blackRating", "whiteAvatarUrl", "blackAvatarUrl",
        time, increment, status, "numMoves",
        "whiteTimeLeftMs", "blackTimeLeftMs", "lastMoveAt", "deadlineAt"
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'in_progress', 0, $11, $11, $12, $13)
      RETURNING ${GAME_COLUMNS}`,
      [
        game.whiteId,
        game.blackId,
        game.whiteUsername,
        game.blackUsername,
        game.whiteRating,
        game.blackRating,
        game.whiteAvatarUrl,
        game.blackAvatarUrl,
        game.time,
        game.increment,
        game.time * 1000,
        game.lastMoveAt,
        game.deadlineAt,
      ]
    );
    return rows[0]!;
  },

  /**
   * Stores a bot game that was played in the browser, already finished and
   * unrated (no rating changes, untimed). See migration 012.
   */
  async insertFinishedBotGame(db: Queryable, game: NewBotGame): Promise<Game> {
    const { rows } = await db.query<Game>(
      `INSERT INTO games (
        "botId", rated, "whiteId", "blackId", "whiteUsername", "blackUsername",
        "whiteRating", "blackRating", "whiteAvatarUrl", "blackAvatarUrl",
        time, increment, status, pgn, fen, "numMoves", result, "endReason", "winnerId", "endedAt"
      ) VALUES ($1, false, $2, $3, $4, $5, $6, $7, $8, $9, NULL, 0, 'finished', $10, $11, $12, $13, $14, $15, now())
      RETURNING ${GAME_COLUMNS}`,
      [
        game.botId,
        game.whiteId,
        game.blackId,
        game.whiteUsername,
        game.blackUsername,
        game.whiteRating,
        game.blackRating,
        game.whiteAvatarUrl,
        game.blackAvatarUrl,
        game.pgn,
        game.fen,
        game.numMoves,
        game.result,
        game.endReason,
        game.winnerId,
      ]
    );
    return rows[0]!;
  },

  async saveMove(
    db: Queryable,
    gameId: number,
    update: {
      fen: string;
      pgn: string;
      numMoves: number;
      whiteTimeLeftMs: number;
      blackTimeLeftMs: number;
      lastMoveAt: Date;
      deadlineAt: Date;
      drawOfferedBy: number | null;
    }
  ): Promise<void> {
    await db.query(
      `UPDATE games SET fen = $2, pgn = $3, "numMoves" = $4,
         "whiteTimeLeftMs" = $5, "blackTimeLeftMs" = $6, "lastMoveAt" = $7,
         "deadlineAt" = $8, "drawOfferedBy" = $9
       WHERE id = $1`,
      [
        gameId,
        update.fen,
        update.pgn,
        update.numMoves,
        update.whiteTimeLeftMs,
        update.blackTimeLeftMs,
        update.lastMoveAt,
        update.deadlineAt,
        update.drawOfferedBy,
      ]
    );
  },

  /** Marks the game finished. Returns false if it was already finished. */
  async finish(
    db: Queryable,
    gameId: number,
    fields: {
      result: string;
      endReason: string;
      winnerId: number | null;
      whiteTimeLeftMs: number | null;
      blackTimeLeftMs: number | null;
      whiteRatingChange: number;
      blackRatingChange: number;
    }
  ): Promise<boolean> {
    const { rowCount } = await db.query(
      `UPDATE games SET status = 'finished', result = $2, "endReason" = $3, "winnerId" = $4,
         "whiteTimeLeftMs" = $5, "blackTimeLeftMs" = $6, "whiteRatingChange" = $7,
         "blackRatingChange" = $8, "endedAt" = now(), "deadlineAt" = NULL, "drawOfferedBy" = NULL
       WHERE id = $1 AND status = 'in_progress'`,
      [
        gameId,
        fields.result,
        fields.endReason,
        fields.winnerId,
        fields.whiteTimeLeftMs,
        fields.blackTimeLeftMs,
        fields.whiteRatingChange,
        fields.blackRatingChange,
      ]
    );
    return rowCount === 1;
  },

  async setDrawOffer(db: Queryable, gameId: number, userId: number | null): Promise<void> {
    await db.query(`UPDATE games SET "drawOfferedBy" = $2 WHERE id = $1`, [gameId, userId]);
  },

  async setRematchRequest(db: Queryable, gameId: number, userId: number | null): Promise<void> {
    await db.query(`UPDATE games SET "rematchRequestedBy" = $2 WHERE id = $1`, [gameId, userId]);
  },

  async setRematchGame(db: Queryable, gameId: number, rematchGameId: number): Promise<void> {
    await db.query(
      `UPDATE games SET "rematchGameId" = $2, "rematchRequestedBy" = NULL WHERE id = $1`,
      [gameId, rematchGameId]
    );
  },

  /** In-progress games are never bot games (migration 012), so this can't return one. */
  async findActiveGameIdForUser(db: Queryable, userId: number): Promise<number | null> {
    const { rows } = await db.query<{ id: number }>(
      `SELECT id FROM games
       WHERE status = 'in_progress' AND ("whiteId" = $1 OR "blackId" = $1)
       LIMIT 1`,
      [userId]
    );
    return rows[0]?.id ?? null;
  },

  async findIdsPastDeadline(db: Queryable, now: Date, limit: number): Promise<number[]> {
    const { rows } = await db.query<{ id: number }>(
      `SELECT id FROM games
       WHERE status = 'in_progress' AND "deadlineAt" <= $1
       ORDER BY "deadlineAt" LIMIT $2`,
      [now, limit]
    );
    return rows.map((r) => r.id);
  },

  /**
   * Games in progress where a friend of the user plays, newest first. The
   * user's own games are left out. In-progress games are few, and the partial
   * index games_deadline_idx covers exactly them.
   */
  async findLiveForFriends(db: Queryable, userId: number, limit: number): Promise<LiveGame[]> {
    const { rows } = await db.query<LiveGame>(
      `WITH friend_ids AS (
         SELECT "userTwoId" AS id FROM friends WHERE "userOneId" = $1
         UNION
         SELECT "userOneId" FROM friends WHERE "userTwoId" = $1
       )
       SELECT ${GAME_COLUMNS} FROM games
       WHERE status = 'in_progress'
         AND ("whiteId" IN (SELECT id FROM friend_ids) OR "blackId" IN (SELECT id FROM friend_ids))
         AND "whiteId" <> $1 AND "blackId" <> $1
       ORDER BY "createdAt" DESC
       LIMIT $2`,
      [userId, limit]
    );
    return rows;
  },

  /** Games in progress with the highest average rating (ratings at game start). */
  async findTopLive(db: Queryable, limit: number): Promise<LiveGame[]> {
    const { rows } = await db.query<LiveGame>(
      `SELECT ${GAME_COLUMNS} FROM games
       WHERE status = 'in_progress'
       ORDER BY ("whiteRating" + "blackRating") DESC, "createdAt" DESC
       LIMIT $1`,
      [limit]
    );
    return rows;
  },

  /** Games for a user, newest first, bot games included. Aborted games are hidden. */
  async findByUserId(
    db: Queryable,
    userId: number,
    limit: number,
    offset: number
  ): Promise<{ games: Game[]; total: number }> {
    const where = `("whiteId" = $1 OR "blackId" = $1) AND result IS DISTINCT FROM 'aborted'`;
    const [{ rows: countRows }, { rows }] = await Promise.all([
      db.query<{ count: string }>(`SELECT COUNT(*) AS count FROM games WHERE ${where}`, [userId]),
      db.query<Game>(
        `SELECT ${GAME_COLUMNS} FROM games WHERE ${where}
         ORDER BY "createdAt" DESC LIMIT $2 OFFSET $3`,
        [userId, limit, offset]
      ),
    ]);
    return { games: rows, total: parseInt(countRows[0]?.count ?? "0", 10) };
  },
};
