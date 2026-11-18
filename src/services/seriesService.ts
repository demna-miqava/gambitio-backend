import type { FastifyInstance } from "fastify";
import type { Queryable } from "../db.js";
import type { LiveGame } from "../models/Game.js";
import type { PlayerColor } from "../models/common.js";
import type { GameResult } from "../game/engine.js";
import {
  expiredSeriesDecision,
  scoreGame,
  seriesColors,
  seriesDecision,
  SERIES_IDLE_EXPIRY_MS,
  type SeriesEndReason,
  type SeriesScore,
  type SeriesStatus,
} from "../game/series.js";
import { AppError } from "../errors/AppError.js";
import { topics, type RealtimeHub } from "../realtime/hub.js";
import { toGameListItem } from "./gameService.js";
import { GAME_LIST_COLUMNS, type GameListRow } from "../repositories/gameRepository.js";

/** A row of the series table. */
export interface SeriesRow extends SeriesScore {
  id: number;
  createdAt: Date;
  /** The longer clock when the series has time odds */
  time: number;
  increment: number;
  /**
   * Each player's starting clock in seconds when they differ (time odds,
   * migration 027); null for an even series
   */
  playerOneTime: number | null;
  playerTwoTime: number | null;
  /** False for a casual series (migration 035). One with time odds is unrated either way */
  rated: boolean;
  status: SeriesStatus;
  winnerId: number | null;
  endReason: SeriesEndReason | null;
  endedAt: Date | null;
}

interface SeriesPlayer {
  id: number;
  username: string;
  avatarUrl: string | null;
  /** Points (a draw is half a point) */
  score: number;
  /** Their starting clock in seconds, when the series has time odds; null otherwise */
  time: number | null;
}

/** A series as sent to clients. */
export interface SeriesSummary {
  id: number;
  createdAt: Date;
  bestOf: number;
  time: number;
  increment: number;
  /** Whether its games change ratings: false for a casual series or one with time odds */
  rated: boolean;
  status: SeriesStatus;
  endReason: SeriesEndReason | null;
  endedAt: Date | null;
  /** Null while active, or when the series was drawn */
  winnerId: number | null;
  gamesPlayed: number;
  playerOne: SeriesPlayer;
  playerTwo: SeriesPlayer;
  /** The game that would be played next (while active) */
  next: { number: number; whiteId: number; blackId: number } | null;
}

const SERIES_COLUMNS = `s.id, s."createdAt", s."playerOneId", s."playerTwoId", s."playerOneStartsWhite",
  s."bestOf", s.time, s.increment, s."playerOneTime", s."playerTwoTime", s.rated, s.status, s."playerOneHalfPoints", s."playerTwoHalfPoints",
  s."gamesPlayed", s."winnerId", s."endReason", s."endedAt"`;

const SUMMARY_SELECT = `SELECT ${SERIES_COLUMNS},
    p1.username AS "playerOneUsername", p1."avatarUrl" AS "playerOneAvatarUrl",
    p2.username AS "playerTwoUsername", p2."avatarUrl" AS "playerTwoAvatarUrl"
  FROM series s
  JOIN users p1 ON p1.id = s."playerOneId"
  JOIN users p2 ON p2.id = s."playerTwoId"`;

type SummaryRow = SeriesRow & {
  playerOneUsername: string;
  playerOneAvatarUrl: string | null;
  playerTwoUsername: string;
  playerTwoAvatarUrl: string | null;
};

export function toSeriesSummary(row: SummaryRow): SeriesSummary {
  const next =
    row.status === "active"
      ? { number: row.gamesPlayed + 1, ...seriesColors(row, row.gamesPlayed + 1) }
      : null;
  return {
    id: row.id,
    createdAt: row.createdAt,
    bestOf: row.bestOf,
    time: row.time,
    increment: row.increment,
    rated: row.rated && (row.playerOneTime === null || row.playerTwoTime === null),
    status: row.status,
    endReason: row.endReason,
    endedAt: row.endedAt,
    winnerId: row.winnerId,
    gamesPlayed: row.gamesPlayed,
    playerOne: {
      id: row.playerOneId,
      username: row.playerOneUsername,
      avatarUrl: row.playerOneAvatarUrl,
      score: row.playerOneHalfPoints / 2,
      time: row.playerOneTime,
    },
    playerTwo: {
      id: row.playerTwoId,
      username: row.playerTwoUsername,
      avatarUrl: row.playerTwoAvatarUrl,
      score: row.playerTwoHalfPoints / 2,
      time: row.playerTwoTime,
    },
    next,
  };
}

const seriesNotFound = () => new AppError("Series not found", "SERIES_NOT_FOUND", 404);

/** Series data access; every function takes the connection (pool or transaction). */
export const seriesRepository = {
  async create(
    tx: Queryable,
    params: {
      challengerId: number;
      challengedId: number;
      challengerColor: PlayerColor;
      bestOf: number;
      time: number;
      increment: number;
      /** Time odds: the challenger's and the challenged player's clocks */
      odds?: { challengerTime: number; challengedTime: number } | null;
      /** False for a casual series. Default: rated (unless it has time odds) */
      rated?: boolean;
    }
  ): Promise<SeriesRow> {
    const { rows } = await tx.query<SeriesRow>(
      `INSERT INTO series ("playerOneId", "playerTwoId", "playerOneStartsWhite", "bestOf", time, increment,
         "playerOneTime", "playerTwoTime", rated)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING ${SERIES_COLUMNS.replace(/s\./g, "")}`,
      [
        params.challengerId,
        params.challengedId,
        params.challengerColor === "white",
        params.bestOf,
        params.time,
        params.increment,
        params.odds?.challengerTime ?? null,
        params.odds?.challengedTime ?? null,
        params.rated !== false,
      ]
    );
    return rows[0]!;
  },

  async find(db: Queryable, seriesId: number): Promise<SeriesRow | null> {
    const { rows } = await db.query<SeriesRow>(`SELECT ${SERIES_COLUMNS} FROM series s WHERE s.id = $1`, [
      seriesId,
    ]);
    return rows[0] ?? null;
  },

  /** Whether a game of the series is being played right now. */
  async hasGameInProgress(db: Queryable, seriesId: number): Promise<boolean> {
    const { rows } = await db.query(
      `SELECT 1 FROM games WHERE "seriesId" = $1 AND status = 'in_progress' LIMIT 1`,
      [seriesId]
    );
    return rows.length > 0;
  },

  async lock(tx: Queryable, seriesId: number): Promise<SeriesRow | null> {
    const { rows } = await tx.query<SeriesRow>(
      `SELECT ${SERIES_COLUMNS} FROM series s WHERE s.id = $1 FOR UPDATE`,
      [seriesId]
    );
    return rows[0] ?? null;
  },

  /**
   * Locks the series row like lock(), and reads it with its players' names,
   * so a caller that needs the summary afterwards doesn't read it again.
   * Only the series row is locked, not the players'.
   */
  async lockSummary(tx: Queryable, seriesId: number): Promise<SummaryRow | null> {
    const { rows } = await tx.query<SummaryRow>(`${SUMMARY_SELECT} WHERE s.id = $1 FOR UPDATE OF s`, [
      seriesId,
    ]);
    return rows[0] ?? null;
  },

  async summary(db: Queryable, seriesId: number): Promise<SeriesSummary | null> {
    const { rows } = await db.query<SummaryRow>(`${SUMMARY_SELECT} WHERE s.id = $1`, [seriesId]);
    return rows[0] ? toSeriesSummary(rows[0]) : null;
  },

  /** Saves the score and returns the series as it now stands, in one statement. */
  async saveScore(
    tx: Queryable,
    seriesId: number,
    score: SeriesScore,
    end: { winnerId: number | null; endReason: SeriesEndReason } | null
  ): Promise<SeriesSummary | null> {
    const { rows } = await tx.query<SummaryRow>(
      `WITH s AS (
         UPDATE series SET "playerOneHalfPoints" = $2, "playerTwoHalfPoints" = $3, "gamesPlayed" = $4,
           status = $5, "winnerId" = $6, "endReason" = $7, "endedAt" = CASE WHEN $5 = 'finished' THEN now() END
         WHERE id = $1
         RETURNING *
       )
       ${SUMMARY_OF_UPDATED}`,
      [
        seriesId,
        score.playerOneHalfPoints,
        score.playerTwoHalfPoints,
        score.gamesPlayed,
        end ? "finished" : "active",
        end?.winnerId ?? null,
        end?.endReason ?? null,
      ]
    );
    return rows[0] ? toSeriesSummary(rows[0]) : null;
  },
};

/** SUMMARY_SELECT reading the series from a CTE named `s` instead of the table. */
const SUMMARY_OF_UPDATED = SUMMARY_SELECT.replace("FROM series s", "FROM s");
if (SUMMARY_OF_UPDATED === SUMMARY_SELECT) throw new Error("SUMMARY_SELECT must read FROM series s");

const isSummaryRow = (row: SeriesRow): row is SummaryRow => "playerOneUsername" in row;

/**
 * Scores a finished series game inside the transaction that ended it (the
 * game row is locked; the series row is locked here, after it, which is the
 * order every series path takes). Returns the series as it now stands.
 *
 * `locked` is the series row when the caller has already locked it in this
 * transaction (it has to, before the players' rows: see finishGame), so it
 * isn't locked and read a second time. From lockSummary, a series that is
 * already over needs no query at all.
 */
export async function recordSeriesResult(
  tx: Queryable,
  game: LiveGame,
  result: GameResult,
  locked?: SeriesRow | null
): Promise<SeriesSummary | null> {
  if (game.seriesId === null) return null;
  const series =
    locked && locked.id === game.seriesId ? locked : await seriesRepository.lockSummary(tx, game.seriesId);
  if (!series) return null;
  if (series.status === "active") {
    const score = scoreGame(series, { whiteId: game.whiteId, blackId: game.blackId, result });
    const decision = seriesDecision(score);
    return seriesRepository.saveScore(
      tx,
      series.id,
      score,
      decision.decided ? { winnerId: decision.winnerId, endReason: "played_out" } : null
    );
  }
  return isSummaryRow(series) ? toSeriesSummary(series) : seriesRepository.summary(tx, series.id);
}

/**
 * Who plays whom in the next game of a game's series, or null when that
 * series is over (a rematch is then an ordinary game). Locks the series.
 */
export async function nextSeriesGame(
  tx: Queryable,
  game: LiveGame
): Promise<{ seriesId: number; number: number; whiteId: number; blackId: number } | null> {
  if (game.seriesId === null) return null;
  const series = await seriesRepository.lock(tx, game.seriesId);
  if (!series || series.status !== "active") return null;
  const number = series.gamesPlayed + 1;
  return { seriesId: series.id, number, ...seriesColors(series, number) };
}

export interface HeadToHead {
  opponent: { id: number; username: string; avatarUrl: string | null };
  /** From the asking player's side; rated games only, aborted games left out */
  wins: number;
  draws: number;
  losses: number;
  series: { won: number; lost: number; drawn: number; active: number };
  recentGames: ReturnType<typeof toGameListItem>[];
  recentSeries: SeriesSummary[];
}

export class SeriesService {
  constructor(
    private fastify: FastifyInstance,
    private hub: RealtimeHub
  ) {}

  async getSeries(seriesId: number) {
    const summary = await seriesRepository.summary(this.fastify.pg, seriesId);
    if (!summary) throw seriesNotFound();
    const { rows } = await this.fastify.pg.query<GameListRow & { seriesGame: number }>(
      `SELECT ${GAME_LIST_COLUMNS} FROM games WHERE "seriesId" = $1 ORDER BY id`,
      [seriesId]
    );
    const { rows: live } = await this.fastify.pg.query<{ id: number }>(
      `SELECT id FROM games WHERE "seriesId" = $1 AND status = 'in_progress' LIMIT 1`,
      [seriesId]
    );
    return {
      series: summary,
      games: rows.map(toGameListItem),
      liveGameId: live[0]?.id ?? null,
    };
  }

  /** A player's series, newest first. */
  async listForUser(userId: number, limit = 20): Promise<SeriesSummary[]> {
    const { rows } = await this.fastify.pg.query<SummaryRow>(
      `${SUMMARY_SELECT}
       WHERE s."playerOneId" = $1 OR s."playerTwoId" = $1
       ORDER BY s."createdAt" DESC LIMIT $2`,
      [userId, limit]
    );
    return rows.map(toSeriesSummary);
  }

  /**
   * Gives the series to the opponent. Not while one of its games is being
   * played: that game is resigned first, like any other.
   */
  async resign(seriesId: number, userId: number): Promise<SeriesSummary> {
    const summary = await this.fastify.pg.transact(async (tx) => {
      const series = await seriesRepository.lock(tx, seriesId);
      if (!series) throw seriesNotFound();
      if (series.playerOneId !== userId && series.playerTwoId !== userId) {
        throw new AppError("You are not playing in this series", "NOT_IN_SERIES", 403);
      }
      if (series.status !== "active") {
        throw new AppError("The series is already over", "SERIES_OVER", 409);
      }
      if (await seriesRepository.hasGameInProgress(tx, seriesId)) {
        throw new AppError("Finish the current game first", "SERIES_GAME_IN_PROGRESS", 409);
      }
      const winnerId = series.playerOneId === userId ? series.playerTwoId : series.playerOneId;
      return (await seriesRepository.saveScore(tx, seriesId, series, { winnerId, endReason: "resignation" }))!;
    });
    await this.ended(summary);
    return summary;
  }

  /**
   * Ends series nobody has played on for SERIES_IDLE_EXPIRY_MS (no game
   * started since the last one ended, or since the series began): the
   * leader on points wins, or the series is drawn. Run by the series sweep.
   */
  async expireStale(now = new Date()): Promise<void> {
    const cutoff = new Date(now.getTime() - SERIES_IDLE_EXPIRY_MS);
    const { rows } = await this.fastify.pg.query<{ id: number }>(
      `SELECT s.id FROM series s
       WHERE s.status = 'active' AND s."createdAt" <= $1
         AND NOT EXISTS (SELECT 1 FROM games g WHERE g."seriesId" = s.id AND g.status = 'in_progress')
         AND COALESCE((SELECT MAX(g."endedAt") FROM games g WHERE g."seriesId" = s.id), s."createdAt") <= $1
       ORDER BY s."createdAt" LIMIT 50`,
      [cutoff]
    );
    for (const { id } of rows) {
      await this.expire(id, cutoff).catch((err) =>
        this.fastify.log.error({ err, seriesId: id }, "Expiring a series failed")
      );
    }
  }

  private async expire(seriesId: number, cutoff: Date): Promise<void> {
    const summary = await this.fastify.pg.transact(async (tx) => {
      const series = await seriesRepository.lock(tx, seriesId);
      if (!series || series.status !== "active") return null;
      // Checked again under the lock: a game may have started meanwhile
      const { rows } = await tx.query<{ idle: boolean }>(
        `SELECT NOT EXISTS (SELECT 1 FROM games WHERE "seriesId" = $1 AND status = 'in_progress')
            AND COALESCE((SELECT MAX("endedAt") FROM games WHERE "seriesId" = $1), $3::timestamptz) <= $2 AS idle`,
        [seriesId, cutoff, series.createdAt]
      );
      if (!rows[0]?.idle) return null;
      const { winnerId } = expiredSeriesDecision(series);
      return (await seriesRepository.saveScore(tx, seriesId, series, { winnerId, endReason: "expired" }))!;
    });
    if (summary) await this.ended(summary);
  }

  /** A series ended outside a game: withdraw challenges to continue it and tell both players. */
  private async ended(summary: SeriesSummary): Promise<void> {
    await this.fastify.challenges
      .withdrawForSeries(summary.id)
      .catch((err) => this.fastify.log.error({ err }, "Failed to withdraw series challenges"));
    await this.publishUpdate(summary);
  }

  /** Tells both players a series changed outside a game (e.g. resigned). Never throws. */
  async publishUpdate(summary: SeriesSummary): Promise<void> {
    for (const playerId of [summary.playerOne.id, summary.playerTwo.id]) {
      await this.hub
        .publish(topics.notifications(playerId), { type: "series_updated", data: { series: summary } })
        .catch((err) => this.fastify.log.error({ err }, "Failed to publish series update"));
    }
  }

  /** Record between two players, from `userId`'s side. */
  async headToHead(userId: number, opponentId: number): Promise<HeadToHead> {
    if (userId === opponentId) {
      throw new AppError("Pick another player", "SELF_HEAD_TO_HEAD", 400);
    }
    const { rows: users } = await this.fastify.pg.query<{
      id: number;
      username: string;
      avatarUrl: string | null;
    }>(`SELECT id, username, "avatarUrl" FROM users WHERE id = $1`, [opponentId]);
    const opponent = users[0];
    if (!opponent) throw new AppError("User not found", "USER_NOT_FOUND", 404);

    // The pair's games only, newest first, from games_pair_finished_idx
    // (migration 030): the expressions and the conditions must stay the
    // index's own for Postgres to use it. Bot games have one player, so they
    // could never match anyway.
    const pair = `LEAST("whiteId", "blackId") = LEAST($1::int, $2::int)
      AND GREATEST("whiteId", "blackId") = GREATEST($1::int, $2::int)
      AND status = 'finished' AND result IS DISTINCT FROM 'aborted' AND "botId" IS NULL`;
    const { rows: totals } = await this.fastify.pg.query<{ wins: string; draws: string; losses: string }>(
      `SELECT
         COUNT(*) FILTER (WHERE "winnerId" = $1) AS wins,
         COUNT(*) FILTER (WHERE result = 'draw') AS draws,
         COUNT(*) FILTER (WHERE "winnerId" = $2) AS losses
       FROM games WHERE ${pair}`,
      [userId, opponentId]
    );
    const { rows: recent } = await this.fastify.pg.query<GameListRow>(
      `SELECT ${GAME_LIST_COLUMNS} FROM games WHERE ${pair} ORDER BY "createdAt" DESC, id DESC LIMIT 10`,
      [userId, opponentId]
    );
    const { rows: seriesRows } = await this.fastify.pg.query<SummaryRow>(
      `${SUMMARY_SELECT}
       WHERE (s."playerOneId" = $1 AND s."playerTwoId" = $2) OR (s."playerOneId" = $2 AND s."playerTwoId" = $1)
       ORDER BY s."createdAt" DESC`,
      [userId, opponentId]
    );
    const allSeries = seriesRows.map(toSeriesSummary);
    const finished = allSeries.filter((s) => s.status === "finished");
    const t = totals[0]!;
    return {
      opponent,
      wins: Number(t.wins),
      draws: Number(t.draws),
      losses: Number(t.losses),
      series: {
        won: finished.filter((s) => s.winnerId === userId).length,
        lost: finished.filter((s) => s.winnerId === opponentId).length,
        drawn: finished.filter((s) => s.winnerId === null).length,
        active: allSeries.length - finished.length,
      },
      recentGames: recent.map(toGameListItem),
      recentSeries: allSeries.slice(0, 5),
    };
  }
}
