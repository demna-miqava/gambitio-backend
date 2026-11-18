import type { Queryable, TxClient } from "../db.js";
import type { Game, LiveGame } from "../models/Game.js";
import type { EndReason, GameResult } from "../game/engine.js";
import { MAX_PAUSE_MS } from "../game/clock.js";

const GAME_COLUMNS = `
  id, "createdAt", pgn, fen, "winnerId", "numMoves", "whiteRating", "blackRating",
  time, increment, "whiteTime", "blackTime", "whiteId", "blackId", "whiteUsername", "blackUsername",
  "whiteAvatarUrl", "blackAvatarUrl", status, result, "endReason", "endedAt",
  "whiteTimeLeftMs", "blackTimeLeftMs", "lastMoveAt", "deadlineAt",
  "drawOfferedBy", "rematchRequestedBy", "rematchGameId",
  "takebackRequestedBy", "takebackDeclinedFor",
  "whiteRatingChange", "blackRatingChange", "botId", rated, "seriesId", "seriesGame",
  "whiteLagBudgetMs", "blackLagBudgetMs", "pausedAt", "drawDeclinedFor",
  "whiteRematchAsked", "blackRematchAsked"`;

/** GAME_COLUMNS without the move list and position, for lists. */
export const GAME_LIST_COLUMNS = GAME_COLUMNS.replace(/\bpgn, fen, /, "");
if (GAME_LIST_COLUMNS === GAME_COLUMNS) throw new Error("GAME_LIST_COLUMNS must drop pgn and fen");

export type GameListRow = Omit<Game, "pgn" | "fen">;

/**
 * GAME_COLUMNS without the move list, for the lists of games in progress:
 * they show the position (fen) but never the moves, which grow with every
 * move and are most of a live row's size.
 */
const LIVE_LIST_COLUMNS = GAME_COLUMNS.replace(/\bpgn, /, "");
if (LIVE_LIST_COLUMNS === GAME_COLUMNS) throw new Error("LIVE_LIST_COLUMNS must drop pgn");

export type LiveGameListRow = Omit<LiveGame, "pgn">;

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
  /** Time odds: each side's starting clock (seconds). The game is then unrated. */
  odds?: { whiteTime: number; blackTime: number } | null;
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

/** What a move (or an accepted takeback) writes to the game row. */
export interface SavedMove {
  fen: string;
  pgn: string;
  numMoves: number;
  whiteTimeLeftMs: number;
  blackTimeLeftMs: number;
  lastMoveAt: Date;
  deadlineAt: Date;
  drawOfferedBy: number | null;
  drawDeclinedFor: number | null;
  whiteLagBudgetMs: number;
  blackLagBudgetMs: number;
}

/** An integer or NULL for inlining into SQL; anything else is a bug, so it throws. */
function sqlInt(value: number | null): string {
  if (value === null) return "NULL";
  if (!Number.isSafeInteger(value)) throw new Error(`Not an integer: ${value}`);
  return String(value);
}

/**
 * The UPDATE that stores a move, as one self-contained statement: values are
 * inlined (strings through the connection's escapeLiteral, numbers checked
 * to be integers) so it can go out in the same simple query as COMMIT,
 * which can't carry parameters. Saves a round trip on every move.
 */
export function saveMoveStatement(
  client: Pick<TxClient, "escapeLiteral">,
  gameId: number,
  update: SavedMove
): string {
  const text = (value: string) => client.escapeLiteral(value);
  const time = (value: Date) => {
    if (!Number.isFinite(value.getTime())) throw new Error("Invalid date");
    return `${text(value.toISOString())}::timestamptz`;
  };
  // Clock values come from arithmetic on stored integers, but are rounded so
  // a fraction can never make the statement fail
  const ms = (value: number) => sqlInt(Math.round(value));
  return `UPDATE games SET fen = ${text(update.fen)}, pgn = ${text(update.pgn)}, "numMoves" = ${sqlInt(update.numMoves)},
     "whiteTimeLeftMs" = ${ms(update.whiteTimeLeftMs)}, "blackTimeLeftMs" = ${ms(update.blackTimeLeftMs)},
     "lastMoveAt" = ${time(update.lastMoveAt)}, "deadlineAt" = ${time(update.deadlineAt)},
     "drawOfferedBy" = ${sqlInt(update.drawOfferedBy)}, "drawDeclinedFor" = ${sqlInt(update.drawDeclinedFor)},
     "whiteLagBudgetMs" = ${ms(update.whiteLagBudgetMs)}, "blackLagBudgetMs" = ${ms(update.blackLagBudgetMs)},
     "takebackRequestedBy" = NULL, "takebackDeclinedFor" = NULL
   WHERE id = ${sqlInt(gameId)}`;
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
        "whiteTimeLeftMs", "blackTimeLeftMs", "lastMoveAt", "deadlineAt", "seriesId", "seriesGame",
        "whiteTime", "blackTime", rated
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'in_progress', 0, $11, $12, $13, $14, $15, $16,
        $17, $18, $19)
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
        (game.odds?.whiteTime ?? game.time) * 1000,
        (game.odds?.blackTime ?? game.time) * 1000,
        game.lastMoveAt,
        game.deadlineAt,
        game.seriesId ?? null,
        game.seriesGame ?? null,
        game.odds?.whiteTime ?? null,
        game.odds?.blackTime ?? null,
        !game.odds,
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

  /**
   * Stores a new position: a move, or an accepted takeback. Either clears a
   * pending takeback request and a declined one's block (migration 021).
   * Runs the statement saveMoveStatement builds; LiveGameService sends that
   * together with COMMIT instead when nothing else follows it.
   */
  async saveMove(db: TxClient, gameId: number, update: SavedMove): Promise<void> {
    await db.query(saveMoveStatement(db, gameId, update));
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
         "blackRatingChange" = $8, "endedAt" = now(), "deadlineAt" = NULL, "drawOfferedBy" = NULL,
         "takebackRequestedBy" = NULL, "takebackDeclinedFor" = NULL, "drawDeclinedFor" = NULL,
         "pausedAt" = NULL
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

  async setTakebackRequest(db: Queryable, gameId: number, userId: number): Promise<void> {
    await db.query(`UPDATE games SET "takebackRequestedBy" = $2 WHERE id = $1`, [gameId, userId]);
  },

  /** Clears the request; `requesterId` can't ask again until the next move. */
  async declineTakeback(db: Queryable, gameId: number, requesterId: number): Promise<void> {
    await db.query(
      `UPDATE games SET "takebackRequestedBy" = NULL, "takebackDeclinedFor" = $2 WHERE id = $1`,
      [gameId, requesterId]
    );
  },

  /** Clears the offer; `offererId` can't offer again until they move (migration 029). */
  async declineDraw(db: Queryable, gameId: number, offererId: number): Promise<void> {
    await db.query(`UPDATE games SET "drawOfferedBy" = NULL, "drawDeclinedFor" = $2 WHERE id = $1`, [
      gameId,
      offererId,
    ]);
  },

  /** Stores `color`'s rematch request, and that they have used their one request (migration 029). */
  async requestRematch(db: Queryable, gameId: number, userId: number, color: "white" | "black"): Promise<void> {
    const asked = color === "white" ? `"whiteRematchAsked"` : `"blackRematchAsked"`;
    await db.query(`UPDATE games SET "rematchRequestedBy" = $2, ${asked} = true WHERE id = $1`, [gameId, userId]);
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
  ): Promise<{
    status: Game["status"];
    deadlineAt: Date | null;
    pausedAt: Date | null;
    whiteId: number | null;
    blackId: number | null;
  } | null> {
    const { rows } = await db.query(
      `SELECT status, "deadlineAt", "pausedAt", "whiteId", "blackId" FROM games WHERE id = $1`,
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

  /**
   * Games whose deadline has passed. A paused game (migration 029) counts only
   * once even the longest resume would have passed it (see pausedDeadline in
   * src/game/clock.ts, which this repeats).
   */
  async findIdsPastDeadline(db: Queryable, now: Date, limit: number): Promise<number[]> {
    const { rows } = await db.query<{ id: number }>(
      `SELECT id FROM games
       WHERE status = 'in_progress' AND "deadlineAt" <= $1
         AND ("pausedAt" IS NULL OR "deadlineAt" <= "pausedAt"
              OR "deadlineAt" + $3 * interval '1 millisecond' <= $1)
       ORDER BY "deadlineAt" LIMIT $2`,
      [now, limit, MAX_PAUSE_MS]
    );
    return rows.map((r) => r.id);
  },

  /**
   * Marks the in-progress games among `gameIds` paused as of `at`, for a
   * shutdown (see LiveGameService.pauseForShutdown). A game already paused
   * keeps its earlier time.
   */
  async pause(db: Queryable, gameIds: number[], at: Date): Promise<number> {
    if (gameIds.length === 0) return 0;
    const { rowCount } = await db.query(
      `UPDATE games SET "pausedAt" = $2
       WHERE id = ANY($1) AND status = 'in_progress' AND "pausedAt" IS NULL`,
      [gameIds, at]
    );
    return rowCount ?? 0;
  },

  /** In-progress games paused before `before`, to resume at startup. */
  async findPausedIds(db: Queryable, before: Date): Promise<number[]> {
    const { rows } = await db.query<{ id: number }>(
      `SELECT id FROM games WHERE status = 'in_progress' AND "pausedAt" < $1`,
      [before]
    );
    return rows.map((r) => r.id);
  },

  /** Ends a pause with the clock moved forward (see resumeShift in src/game/clock.ts). */
  async resume(db: Queryable, gameId: number, update: { lastMoveAt: Date; deadlineAt: Date | null }): Promise<void> {
    await db.query(`UPDATE games SET "lastMoveAt" = $2, "deadlineAt" = $3, "pausedAt" = NULL WHERE id = $1`, [
      gameId,
      update.lastMoveAt,
      update.deadlineAt,
    ]);
  },

  /**
   * Games in progress where a friend of the user plays, newest first. The
   * user's own games are left out. In-progress games are few, and the partial
   * indexes games_white_live_idx / games_black_live_idx cover exactly them.
   */
  async findLiveForFriends(db: Queryable, userId: number, limit: number): Promise<LiveGameListRow[]> {
    const { rows } = await db.query<LiveGameListRow>(
      `WITH friend_ids AS (
         SELECT "userTwoId" AS id FROM friends WHERE "userOneId" = $1
         UNION
         SELECT "userOneId" FROM friends WHERE "userTwoId" = $1
       )
       SELECT ${LIVE_LIST_COLUMNS} FROM games
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
  async findTopLive(db: Queryable, limit: number): Promise<LiveGameListRow[]> {
    const { rows } = await db.query<LiveGameListRow>(
      `SELECT ${LIVE_LIST_COLUMNS} FROM games
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

  /**
   * Games findPageByUserId can return: the user's finished, listed games,
   * kept as a counter on their row (migration 030, maintained by finishGame
   * and saveBotGame), plus the ones in progress (none or one; each side uses
   * its partial index on games in progress). Never reads the history itself.
   */
  async countByUserId(db: Queryable, userId: number): Promise<number> {
    const { rows } = await db.query<{ n: number }>(
      `SELECT u."listedGames" + (
           SELECT COUNT(*) FROM games
           WHERE status = 'in_progress' AND ("whiteId" = u.id OR "blackId" = u.id)
         )::int AS n
       FROM users u WHERE u.id = $1`,
      [userId]
    );
    return Number(rows[0]?.n ?? 0);
  },
};
