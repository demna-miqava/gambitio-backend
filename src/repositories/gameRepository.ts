import type { Queryable } from "../db.js";
import type { Game, LiveGame } from "../models/Game.js";
import type { EndReason, GameResult } from "../game/engine.js";

const GAME_COLUMNS = `
  id, "createdAt", pgn, fen, "winnerId", "numMoves", "whiteRating", "blackRating",
  time, increment, "whiteId", "blackId", "whiteUsername", "blackUsername",
  "whiteAvatarUrl", "blackAvatarUrl", status, result, "endReason", "endedAt",
  "whiteTimeLeftMs", "blackTimeLeftMs", "lastMoveAt", "deadlineAt",
  "drawOfferedBy", "rematchRequestedBy", "rematchGameId",
  "whiteRatingChange", "blackRatingChange", "botId", rated, "seriesId", "seriesGame"`;

/** GAME_COLUMNS without the move list and position, for lists. */
export const GAME_LIST_COLUMNS = GAME_COLUMNS.replace(/\bpgn, fen, /, "");
if (GAME_LIST_COLUMNS === GAME_COLUMNS) throw new Error("GAME_LIST_COLUMNS must drop pgn and fen");

export type GameListRow = Omit<Game, "pgn" | "fen">;

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
  seriesId?: number | null;
  seriesGame?: number | null;
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

  /**
   * Opens a transaction on `client` and locks the game row, in one round
   * trip: both statements go out as a single simple query, which can't
   * carry parameters, so the id is inlined (after checking it is a plain
   * positive integer). Returns null, with the transaction still open, if
   * there is no such game.
   */
  async beginAndLock(client: Queryable, gameId: number): Promise<Game | null> {
    if (!Number.isSafeInteger(gameId) || gameId <= 0) throw new Error(`Invalid game id ${gameId}`);
    const results = (await client.query(
      `BEGIN; SELECT ${GAME_COLUMNS} FROM games WHERE id = ${gameId} FOR UPDATE`
    )) as unknown as { rows: Game[] }[];
    return results[1]?.rows[0] ?? null;
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
        "whiteTimeLeftMs", "blackTimeLeftMs", "lastMoveAt", "deadlineAt", "seriesId", "seriesGame"
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'in_progress', 0, $11, $11, $12, $13, $14, $15)
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
        game.seriesId ?? null,
        game.seriesGame ?? null,
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

  /** New clock times (given time) without a move */
  async saveClock(
    db: Queryable,
    gameId: number,
    update: { whiteTimeLeftMs: number; blackTimeLeftMs: number; deadlineAt: Date }
  ): Promise<void> {
    await db.query(
      `UPDATE games SET "whiteTimeLeftMs" = $2, "blackTimeLeftMs" = $3, "deadlineAt" = $4
       WHERE id = $1`,
      [gameId, update.whiteTimeLeftMs, update.blackTimeLeftMs, update.deadlineAt]
    );
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

  /** Just what's needed to tell whether a game's deadline has passed (no lock, no PGN). */
  async findDeadline(
    db: Queryable,
    gameId: number
  ): Promise<{ status: Game["status"]; deadlineAt: Date | null; whiteId: number | null; blackId: number | null } | null> {
    const { rows } = await db.query(
      `SELECT status, "deadlineAt", "whiteId", "blackId" FROM games WHERE id = $1`,
      [gameId]
    );
    return rows[0] ?? null;
  },

  /** Every game in progress with its deadline, to arm deadline timers at startup. */
  async findLiveDeadlines(db: Queryable): Promise<{ id: number; deadlineAt: Date | null }[]> {
    const { rows } = await db.query<{ id: number; deadlineAt: Date | null }>(
      `SELECT id, "deadlineAt" FROM games WHERE status = 'in_progress'`
    );
    return rows;
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
   * indexes games_white_live_idx / games_black_live_idx cover exactly them.
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

  /**
   * One page of a user's games, newest first, bot games included. Aborted
   * games are hidden. Without pgn and fen: the history list doesn't show
   * them, and they are most of a row's size.
   *
   * Written as two scans, one per color, each walking its (player,
   * createdAt DESC) index and stopping after offset + limit rows. A single
   * WHERE "whiteId" = $1 OR "blackId" = $1 can't be read in index order, so
   * it would fetch and sort every game the user ever played.
   */
  async findPageByUserId(db: Queryable, userId: number, limit: number, offset: number): Promise<GameListRow[]> {
    const side = (column: string, extra = "") => `(
        SELECT ${GAME_LIST_COLUMNS} FROM games
        WHERE "${column}" = $1 ${extra} AND result IS DISTINCT FROM 'aborted'
        ORDER BY "createdAt" DESC, id DESC LIMIT $2)`;
    const { rows } = await db.query<GameListRow>(
      `SELECT * FROM (
         ${side("whiteId")}
         UNION ALL
         ${side("blackId", `AND "whiteId" IS DISTINCT FROM $1`)}
       ) page
       ORDER BY "createdAt" DESC, id DESC
       LIMIT $3 OFFSET $4`,
      [userId, offset + limit, limit, offset]
    );
    return rows;
  },

  /** Games findPageByUserId can return, counted per color so each count uses its index. */
  async countByUserId(db: Queryable, userId: number): Promise<number> {
    const { rows } = await db.query<{ n: number }>(
      `SELECT
         (SELECT COUNT(*) FROM games WHERE "whiteId" = $1 AND result IS DISTINCT FROM 'aborted')
       + (SELECT COUNT(*) FROM games
          WHERE "blackId" = $1 AND "whiteId" IS DISTINCT FROM $1 AND result IS DISTINCT FROM 'aborted')
         AS n`,
      [userId]
    );
    return Number(rows[0]?.n ?? 0);
  },
};
