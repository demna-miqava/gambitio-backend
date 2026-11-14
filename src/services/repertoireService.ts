import type { FastifyInstance } from "fastify";
import { Chess } from "chess.js";
import type { PlayerColor } from "../models/common.js";
import { AppError } from "../errors/AppError.js";
import {
  buildBook,
  checkGame,
  MAX_LINES_PER_USER,
  nextDue,
  normalizeLine,
  type GameCheck,
} from "../game/repertoire.js";

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
   */
  async checkRecentGames(userId: number, limit: number): Promise<RepertoireGameCheck[]> {
    const lines = await this.list(userId);
    const books = {
      white: buildBook(lines.filter((l) => l.color === "white")),
      black: buildBook(lines.filter((l) => l.color === "black")),
    };
    // One scan per colour, each walking its (player, createdAt) index
    const side = (column: string, extra = "") => `(
      SELECT id, "createdAt", pgn, result, "whiteId", "blackId", "whiteUsername", "blackUsername", "botId"
      FROM games
      WHERE "${column}" = $1 ${extra} AND status = 'finished' AND result IS DISTINCT FROM 'aborted'
        AND "numMoves" > 0
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

    return rows.map((game) => {
      const color: PlayerColor = game.whiteId === userId ? "white" : "black";
      const chess = new Chess();
      let sans: string[] = [];
      try {
        if (game.pgn) chess.loadPgn(game.pgn);
        sans = chess.history();
      } catch {
        sans = [];
      }
      const won = game.result === (color === "white" ? "white_win" : "black_win");
      const isWhite = color === "white";
      return {
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
      };
    });
  }
}
