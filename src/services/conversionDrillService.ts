import type { Queryable } from "../db.js";
import type { PlayerColor } from "../models/common.js";
import type { EndReason, GameResult } from "../game/engine.js";
import { AppError } from "../errors/AppError.js";
import { CONVERSION_MIN_PLIES, drillPosition, isClearlyWinning, notWonBy } from "../game/conversion.js";
import { nextDue } from "../game/repertoire.js";

/** Drills one player can keep; scanning stops adding new ones beyond it */
export const MAX_DRILLS_PER_USER = 300;

export type DrillEval = { cp: number } | { mate: number };

/** A drill as sent to clients. */
export interface ConversionDrill {
  id: number;
  gameId: number;
  /** Half-moves of the game before the position */
  ply: number;
  fen: string;
  color: PlayerColor;
  /** The evaluation when it was found, from the player's side */
  eval: DrillEval;
  createdAt: Date;
  attempts: number;
  successes: number;
  streak: number;
  lastAttemptAt: Date | null;
  dueAt: Date;
  bestMoves: number | null;
  /** The game it came from, for "from your game against …" */
  game: {
    createdAt: Date;
    result: GameResult | null;
    endReason: EndReason | null;
    time: number | null;
    increment: number;
    opponent: { id: number | null; username: string; avatarUrl: string | null };
    botId: string | null;
  };
}

/** A finished game the browser still has to look at. */
export interface ScanCandidate {
  gameId: number;
  pgn: string;
  color: PlayerColor;
  createdAt: Date;
}

interface DrillRow {
  id: number;
  gameId: number;
  ply: number;
  fen: string;
  color: PlayerColor;
  evalCp: number | null;
  evalMate: number | null;
  createdAt: Date;
  attempts: number;
  successes: number;
  streak: number;
  lastAttemptAt: Date | null;
  dueAt: Date;
  bestMoves: number | null;
  gameCreatedAt: Date;
  result: GameResult | null;
  endReason: EndReason | null;
  time: number | null;
  increment: number;
  botId: string | null;
  opponentId: number | null;
  opponentUsername: string;
  opponentAvatarUrl: string | null;
}

const DRILL_SELECT = `SELECT d.id, d."gameId", d.ply, d.fen, d.color, d."evalCp", d."evalMate", d."createdAt",
    d.attempts, d.successes, d.streak, d."lastAttemptAt", d."dueAt", d."bestMoves",
    g."createdAt" AS "gameCreatedAt", g.result, g."endReason", g.time, g.increment, g."botId",
    CASE WHEN d.color = 'white' THEN g."blackId" ELSE g."whiteId" END AS "opponentId",
    CASE WHEN d.color = 'white' THEN g."blackUsername" ELSE g."whiteUsername" END AS "opponentUsername",
    CASE WHEN d.color = 'white' THEN g."blackAvatarUrl" ELSE g."whiteAvatarUrl" END AS "opponentAvatarUrl"
  FROM conversion_drills d JOIN games g ON g.id = d."gameId"`;

function toDrill(row: DrillRow): ConversionDrill {
  return {
    id: row.id,
    gameId: row.gameId,
    ply: row.ply,
    fen: row.fen,
    color: row.color,
    eval: row.evalMate !== null ? { mate: row.evalMate } : { cp: row.evalCp! },
    createdAt: row.createdAt,
    attempts: row.attempts,
    successes: row.successes,
    streak: row.streak,
    lastAttemptAt: row.lastAttemptAt,
    dueAt: row.dueAt,
    bestMoves: row.bestMoves,
    game: {
      createdAt: row.gameCreatedAt,
      result: row.result,
      endReason: row.endReason,
      time: row.time,
      increment: row.increment,
      opponent: { id: row.opponentId, username: row.opponentUsername, avatarUrl: row.opponentAvatarUrl },
      botId: row.botId,
    },
  };
}

const drillNotFound = () => new AppError("Drill not found", "DRILL_NOT_FOUND", 404);

/**
 * Conversion drills (src/game/conversion.ts). The browser does the engine
 * work: it asks for games to scan, reports what it found in each, and plays
 * the drills. The server keeps the drills, checks the positions and
 * schedules reviews.
 */
export class ConversionDrillService {
  constructor(private db: Queryable) {}

  /** The player's drills, due ones first. */
  async list(userId: number): Promise<ConversionDrill[]> {
    const { rows } = await this.db.query<DrillRow>(
      `${DRILL_SELECT} WHERE d."userId" = $1 ORDER BY d."dueAt", d.id LIMIT $2`,
      [userId, MAX_DRILLS_PER_USER]
    );
    return rows.map(toDrill);
  }

  async get(userId: number, drillId: number): Promise<ConversionDrill> {
    const { rows } = await this.db.query<DrillRow>(`${DRILL_SELECT} WHERE d.id = $1 AND d."userId" = $2`, [
      drillId,
      userId,
    ]);
    if (!rows[0]) throw drillNotFound();
    return toDrill(rows[0]);
  }

  /**
   * The player's most recent finished games they didn't win and haven't had
   * scanned, with their moves. Each colour is read from its own
   * (player, createdAt) index.
   */
  async candidates(userId: number, limit: number): Promise<ScanCandidate[]> {
    const side = (column: "whiteId" | "blackId", color: PlayerColor, loss: GameResult) => `(
      SELECT g.id AS "gameId", g.pgn, '${color}' AS color, g."createdAt"
      FROM games g
      WHERE g."${column}" = $1 AND g.status = 'finished' AND g.result IS NOT NULL
        AND g.result IN ('draw', '${loss}') AND g."numMoves" >= ${CONVERSION_MIN_PLIES} AND g.pgn IS NOT NULL
        -- Table games (migration 040) show in history and review only
        AND NOT g."tableGame"
        AND NOT EXISTS (SELECT 1 FROM conversion_scans s WHERE s."userId" = $1 AND s."gameId" = g.id)
      ORDER BY g."createdAt" DESC, g.id DESC LIMIT $2)`;
    const { rows } = await this.db.query<ScanCandidate>(
      `SELECT * FROM (${side("whiteId", "white", "black_win")} UNION ALL ${side("blackId", "black", "white_win")}) c
       ORDER BY "createdAt" DESC, "gameId" DESC LIMIT $2`,
      [userId, limit]
    );
    return rows;
  }

  /**
   * Records that the player's browser scanned a game, and the drill it found
   * there, if any. The position is computed from the game here; a game that
   * isn't the player's, or that they won, is refused. Scanning a game twice
   * keeps the first drill. Returns the new drill, or null.
   */
  async recordScan(
    userId: number,
    gameId: number,
    found: { ply: number; eval: DrillEval } | null
  ): Promise<ConversionDrill | null> {
    const { rows: games } = await this.db.query<{
      pgn: string | null;
      whiteId: number | null;
      blackId: number | null;
      status: string;
      result: GameResult | null;
    }>(`SELECT pgn, "whiteId", "blackId", status, result FROM games WHERE id = $1 AND NOT "tableGame"`, [gameId]);
    const game = games[0];
    const color: PlayerColor | null =
      game?.whiteId === userId ? "white" : game?.blackId === userId ? "black" : null;
    if (!game || !color) throw new AppError("Game not found", "GAME_NOT_FOUND", 404);
    if (game.status !== "finished" || !notWonBy(color, game.result)) {
      throw new AppError("Only games you didn't win have drills", "NOT_A_MISSED_WIN", 409);
    }

    let fen: string | null = null;
    if (found) {
      if (!isClearlyWinning(found.eval)) {
        throw new AppError("That position isn't clearly winning", "NOT_WINNING", 400);
      }
      fen = drillPosition(game.pgn ?? "", found.ply, color);
      if (!fen) throw new AppError("That position isn't one of your moves in the game", "BAD_POSITION", 400);
    }

    await this.db.query(
      `INSERT INTO conversion_scans ("userId", "gameId") VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [userId, gameId]
    );
    if (!found || !fen) return null;
    const { rows } = await this.db.query<{ id: number }>(
      `INSERT INTO conversion_drills ("userId", "gameId", ply, fen, color, "evalCp", "evalMate")
       SELECT $1, $2, $3, $4, $5, $6, $7
       WHERE (SELECT COUNT(*) FROM conversion_drills WHERE "userId" = $1) < $8
       ON CONFLICT ("userId", "gameId") DO NOTHING
       RETURNING id`,
      [
        userId,
        gameId,
        found.ply,
        fen,
        color,
        "cp" in found.eval ? found.eval.cp : null,
        "mate" in found.eval ? found.eval.mate : null,
        MAX_DRILLS_PER_USER,
      ]
    );
    return rows[0] ? this.get(userId, rows[0].id) : null;
  }

  /**
   * Records a finished attempt and schedules the next review: a conversion
   * pushes the drill back (1, 3, 7… days), a failure makes it due at once.
   */
  async recordAttempt(
    userId: number,
    drillId: number,
    attempt: { success: boolean; moves: number },
    now = new Date()
  ): Promise<ConversionDrill> {
    const { rows: current } = await this.db.query<{ streak: number }>(
      `SELECT streak FROM conversion_drills WHERE id = $1 AND "userId" = $2`,
      [drillId, userId]
    );
    if (!current[0]) throw drillNotFound();
    const due = nextDue(now, attempt.success, current[0].streak);
    await this.db.query(
      `UPDATE conversion_drills SET attempts = attempts + 1, successes = successes + $3::int,
         streak = $4, "dueAt" = $5, "lastAttemptAt" = $6,
         "bestMoves" = CASE WHEN $3::int = 1 THEN LEAST(COALESCE("bestMoves", $7::smallint), $7::smallint)
                       ELSE "bestMoves" END
       WHERE id = $1 AND "userId" = $2`,
      [drillId, userId, attempt.success ? 1 : 0, due.streak, due.dueAt, now, attempt.moves]
    );
    return this.get(userId, drillId);
  }

  /** Drops a drill the player doesn't want (the game stays scanned). */
  async remove(userId: number, drillId: number): Promise<void> {
    const { rowCount } = await this.db.query(`DELETE FROM conversion_drills WHERE id = $1 AND "userId" = $2`, [
      drillId,
      userId,
    ]);
    if (!rowCount) throw drillNotFound();
  }
}
