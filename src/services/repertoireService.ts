import type { FastifyInstance } from "fastify";
import { setImmediate as nextTurn } from "node:timers/promises";
import type { PlayerColor } from "../models/common.js";
import { AppError } from "../errors/AppError.js";
import {
  BookBuilder,
  checkGame,
  MAX_LINE_PLIES,
  MAX_LINES_PER_USER,
  nextDue,
  normalizeLine,
  pgnSans,
  type GameCheck,
} from "../game/repertoire.js";

/** Recent games GET /repertoire/check compares, by default and at most. */
export const REPERTOIRE_CHECK_GAMES = { default: 20, max: 20 };
/** Lines added to the books between turns of the event loop (each is a few chess.js moves). */
const BOOK_LINES_PER_TURN = 10;

interface LineRow {
  id: number;
  color: PlayerColor;
  name: string;
  moves: string;
  plies: number;
  createdAt: Date;
  updatedAt: Date;
  practiceAttempts: number;
  practiceCorrect: number;
  streak: number;
  lastPracticedAt: Date | null;
  dueAt: Date;
}

export interface RepertoireLine extends Omit<LineRow, "moves"> {
  /** SAN from the starting position */
  moves: string[];
}

const LINE_COLUMNS = `id, color, name, moves, plies, "createdAt", "updatedAt", "practiceAttempts",
  "practiceCorrect", streak, "lastPracticedAt", "dueAt"`;

const toLine = (row: LineRow): RepertoireLine => ({ ...row, moves: row.moves.split(" ") });

const lineNotFound = () => new AppError("Line not found", "LINE_NOT_FOUND", 404);

/** Recent games compared with the repertoire. */
export interface RepertoireGameCheck extends GameCheck {
  gameId: number;
  createdAt: Date;
  color: PlayerColor;
  opponent: { id: number | null; username: string };
  result: string | null;
  /** From the player's side */
  outcome: "win" | "loss" | "draw";
  botId: string | null;
}

export class RepertoireService {
  constructor(private fastify: FastifyInstance) {}

  async list(userId: number): Promise<RepertoireLine[]> {
    const { rows } = await this.fastify.pg.query<LineRow>(
      `SELECT ${LINE_COLUMNS} FROM repertoire_lines WHERE "userId" = $1 ORDER BY color DESC, moves`,
      [userId]
    );
    return rows.map(toLine);
  }

  async create(
    userId: number,
    input: { color: PlayerColor; name: string; moves: string[] }
  ): Promise<RepertoireLine> {
    const moves = normalizeLine(input.moves);
    const { rows: count } = await this.fastify.pg.query<{ n: string }>(
      `SELECT COUNT(*) AS n FROM repertoire_lines WHERE "userId" = $1`,
      [userId]
    );
    if (Number(count[0]!.n) >= MAX_LINES_PER_USER) {
      throw new AppError(
        `A repertoire can hold up to ${MAX_LINES_PER_USER} lines`,
        "REPERTOIRE_FULL",
        409
      );
    }
    const { rows } = await this.fastify.pg.query<LineRow>(
      `INSERT INTO repertoire_lines ("userId", color, name, moves, plies)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT ("userId", color, moves) DO NOTHING
       RETURNING ${LINE_COLUMNS}`,
      [userId, input.color, input.name.trim(), moves.join(" "), moves.length]
    );
    if (!rows[0]) {
      throw new AppError("This line is already in your repertoire", "LINE_EXISTS", 409);
    }
    return toLine(rows[0]);
  }

  async update(
    userId: number,
    lineId: number,
    input: { name?: string | undefined; color?: PlayerColor | undefined }
  ): Promise<RepertoireLine> {
    const { rows } = await this.fastify.pg.query<LineRow>(
      `UPDATE repertoire_lines SET
         name = COALESCE($3, name), color = COALESCE($4, color), "updatedAt" = now()
       WHERE id = $1 AND "userId" = $2
       RETURNING ${LINE_COLUMNS}`,
      [lineId, userId, input.name?.trim() ?? null, input.color ?? null]
    );
    if (!rows[0]) throw lineNotFound();
    return toLine(rows[0]);
  }

  async remove(userId: number, lineId: number): Promise<void> {
    const { rowCount } = await this.fastify.pg.query(
      `DELETE FROM repertoire_lines WHERE id = $1 AND "userId" = $2`,
      [lineId, userId]
    );
    if (!rowCount) throw lineNotFound();
  }

  /** Records a practice run of a line and schedules its next review. */
  async recordPractice(userId: number, lineId: number, correct: boolean): Promise<RepertoireLine> {
    return this.fastify.pg.transact(async (tx) => {
      const { rows: current } = await tx.query<{ streak: number }>(
        `SELECT streak FROM repertoire_lines WHERE id = $1 AND "userId" = $2 FOR UPDATE`,
        [lineId, userId]
      );
      if (!current[0]) throw lineNotFound();
      const now = new Date();
      const due = nextDue(now, correct, current[0].streak);
      const { rows } = await tx.query<LineRow>(
        `UPDATE repertoire_lines SET
           "practiceAttempts" = "practiceAttempts" + 1,
           "practiceCorrect" = "practiceCorrect" + $3::int,
           streak = $4, "dueAt" = $5, "lastPracticedAt" = $6
         WHERE id = $1 AND "userId" = $2
         RETURNING ${LINE_COLUMNS}`,
        [lineId, userId, correct ? 1 : 0, due.streak, due.dueAt, now]
      );
      return toLine(rows[0]!);
    });
  }

  /**
   * The player's most recent finished games (online and against bots),
   * each compared with the repertoire for the colour they had.
   *
   * This is chess.js work on the event loop, which every live game on the
   * instance shares, so it is kept small and done in slices: each game's
   * moves are read from its PGN text and played once (checkGame, and only
   * while they are in the book), and the loop lets other work run every few
   * lines of the book and between games.
   */
  async checkRecentGames(userId: number, limit: number): Promise<RepertoireGameCheck[]> {
    const lines = await this.list(userId);
    const builders = { white: new BookBuilder(), black: new BookBuilder() };
    for (const [i, line] of lines.entries()) {
      if (i > 0 && i % BOOK_LINES_PER_TURN === 0) await nextTurn();
      builders[line.color].add(line);
    }
    const books = { white: builders.white.book, black: builders.black.book };
    // One scan per colour, each walking its (player, createdAt) index
    const side = (column: string, extra = "") => `(
      SELECT id, "createdAt", pgn, result, "whiteId", "blackId", "whiteUsername", "blackUsername", "botId"
      FROM games
      WHERE "${column}" = $1 ${extra} AND status = 'finished' AND result IS DISTINCT FROM 'aborted'
        AND "numMoves" > 0
        -- A game from a set opening (migration 036) says nothing of the player's repertoire
        AND "startPly" = 0
        -- Nor is a table game (migration 040) checked against it
        AND NOT "tableGame"
      ORDER BY "createdAt" DESC, id DESC LIMIT $2)`;
    const { rows } = await this.fastify.pg.query<{
      id: number;
      createdAt: Date;
      pgn: string | null;
      result: string | null;
      whiteId: number | null;
      blackId: number | null;
      whiteUsername: string;
      blackUsername: string;
      botId: string | null;
    }>(
      `SELECT * FROM (${side("whiteId")} UNION ALL ${side("blackId", `AND "whiteId" IS DISTINCT FROM $1`)}) g
       ORDER BY "createdAt" DESC, id DESC LIMIT $2`,
      [userId, limit]
    );

    const checks: RepertoireGameCheck[] = [];
    for (const game of rows) {
      await nextTurn();
      const color: PlayerColor = game.whiteId === userId ? "white" : "black";
      // A line has at most MAX_LINE_PLIES moves, so checkGame stops by then
      const sans = game.pgn ? pgnSans(game.pgn, MAX_LINE_PLIES + 1) : [];
      const won = game.result === (color === "white" ? "white_win" : "black_win");
      const isWhite = color === "white";
      checks.push({
        gameId: game.id,
        createdAt: game.createdAt,
        color,
        opponent: {
          id: isWhite ? game.blackId : game.whiteId,
          username: isWhite ? game.blackUsername : game.whiteUsername,
        },
        result: game.result,
        outcome: game.result === "draw" ? "draw" : won ? "win" : "loss",
        botId: game.botId,
        ...checkGame(books[color], sans, color),
      });
    }
    return checks;
  }
}
