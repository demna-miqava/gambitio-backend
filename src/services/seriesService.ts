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
  seriesOdds,
  SERIES_IDLE_EXPIRY_MS,
  type SeriesEndReason,
  type SeriesScore,
  type SeriesStatus,
} from "../game/series.js";
import {
  MAX_NO_SHOWS,
  NEXT_GAME_DELAY_MS,
  lastGameStartAt,
  scoreTimedGame,
  timedMatchEnd,
  timedMatchWinner,
  TIMED_MATCH_BEST_OF,
  type TimedScore,
} from "../game/timedMatch.js";
import { AppError } from "../errors/AppError.js";
import { topics, type RealtimeHub } from "../realtime/hub.js";
import { AlreadyInGameError, createGame, linkNextGame, toGameListItem } from "./gameService.js";
import { GAME_LIST_COLUMNS, type GameListRow } from "../repositories/gameRepository.js";
import { openingAllowsRating, openingSummary } from "../game/openings.js";
import { blocksBetween } from "../repositories/blockRepository.js";

/** A row of the series table. */
export interface SeriesRow extends SeriesScore, TimedScore {
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
  /** The opening every game starts from (migration 036); null for the initial position */
  openingId: string | null;
  /** Set for a timed match (migration 039): its length, and when its time is up */
  matchMinutes: number | null;
  endsAt: Date | null;
  status: SeriesStatus;
  winnerId: number | null;
  endReason: SeriesEndReason | null;
  endedAt: Date | null;
}

export const isTimedMatch = (series: Pick<SeriesRow, "matchMinutes">): boolean => series.matchMinutes !== null;

/** Whether the game is part of a timed match that is still being played (no lock taken). */
export async function inActiveTimedMatch(db: Queryable, game: { seriesId: number | null }): Promise<boolean> {
  if (game.seriesId === null) return false;
  const series = await seriesRepository.find(db, game.seriesId);
  return series !== null && series.status === "active" && isTimedMatch(series);
}

interface SeriesPlayer {
  id: number;
  username: string;
  avatarUrl: string | null;
  /** Points (a draw is half a point); in a timed match, arena points */
  score: number;
  /** Their starting clock in seconds, when the series has time odds; null otherwise */
  time: number | null;
  /** Wins in a row (timed matches: from STREAK_AFTER on, points count double); 0 otherwise */
  streak: number;
}

/** A series as sent to clients. */
export interface SeriesSummary {
  id: number;
  createdAt: Date;
  /** 0 for a timed match */
  bestOf: number;
  /** A timed match's length in minutes; null for a best-of series */
  matchMinutes: number | null;
  /** When a timed match's time is up; null for a best-of series */
  endsAt: Date | null;
  /** After this no new game of a timed match starts; null for a best-of series */
  lastGameStartsBy: Date | null;
  time: number;
  increment: number;
  /** Whether its games change ratings: false for a casual series or one with time odds */
  rated: boolean;
  /** The opening every game starts from; null for the initial position */
  opening: ReturnType<typeof openingSummary>;
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
  s."bestOf", s.time, s.increment, s."playerOneTime", s."playerTwoTime", s.rated, s."openingId", s.status, s."playerOneHalfPoints", s."playerTwoHalfPoints",
  s."gamesPlayed", s."winnerId", s."endReason", s."endedAt", s."matchMinutes", s."endsAt", s."playerOnePoints",
  s."playerTwoPoints", s."playerOneStreak", s."playerTwoStreak", s."noShows"`;

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
  const timed = isTimedMatch(row);
  return {
    id: row.id,
    createdAt: row.createdAt,
    bestOf: row.bestOf,
    matchMinutes: row.matchMinutes,
    endsAt: row.endsAt,
    lastGameStartsBy: row.endsAt && new Date(lastGameStartAt(row.endsAt.getTime(), row.time)),
    time: row.time,
    increment: row.increment,
    rated: row.rated && (row.playerOneTime === null || row.playerTwoTime === null),
    opening: openingSummary(row.openingId),
    status: row.status,
    endReason: row.endReason,
    endedAt: row.endedAt,
    winnerId: row.winnerId,
    gamesPlayed: row.gamesPlayed,
    playerOne: {
      id: row.playerOneId,
      username: row.playerOneUsername,
      avatarUrl: row.playerOneAvatarUrl,
      score: timed ? row.playerOnePoints : row.playerOneHalfPoints / 2,
      time: row.playerOneTime,
      streak: row.playerOneStreak,
    },
    playerTwo: {
      id: row.playerTwoId,
      username: row.playerTwoUsername,
      avatarUrl: row.playerTwoAvatarUrl,
      score: timed ? row.playerTwoPoints : row.playerTwoHalfPoints / 2,
      time: row.playerTwoTime,
      streak: row.playerTwoStreak,
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
      /** The opening every game starts from (src/game/openings.ts) */
      openingId?: string | null;
      /** A timed match of this many minutes, from now (bestOf is then ignored) */
      matchMinutes?: number | null;
    }
  ): Promise<SeriesRow> {
    const matchMinutes = params.matchMinutes ?? null;
    const { rows } = await tx.query<SeriesRow>(
      `INSERT INTO series ("playerOneId", "playerTwoId", "playerOneStartsWhite", "bestOf", time, increment,
         "playerOneTime", "playerTwoTime", rated, "openingId", "matchMinutes", "endsAt")
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::smallint,
         CASE WHEN $11::smallint IS NOT NULL THEN now() + make_interval(mins => $11::int) END)
       RETURNING ${SERIES_COLUMNS.replace(/s\./g, "")}`,
      [
        params.challengerId,
        params.challengedId,
        params.challengerColor === "white",
        matchMinutes !== null ? TIMED_MATCH_BEST_OF : params.bestOf,
        params.time,
        params.increment,
        params.odds?.challengerTime ?? null,
        params.odds?.challengedTime ?? null,
        // As for the challenge (ChallengeService.send): from an opening only a
        // mirror match is rated. Every game takes it from here
        params.rated !== false &&
          openingAllowsRating(params.openingId, {
            bestOf: matchMinutes !== null ? TIMED_MATCH_BEST_OF : params.bestOf,
            matchMinutes,
          }),
        params.openingId ?? null,
        matchMinutes,
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

  /**
   * The losers of the series' last `count` counted games before `gameId`,
   * newest first: for a timed match whose "noShows" counts them as no-shows,
   * the players who never moved (a no-show game is always a loss for them).
   * From games_series_idx.
   */
  async noShowLosers(db: Queryable, seriesId: number, gameId: number, count: number): Promise<number[]> {
    const { rows } = await db.query<{ loserId: number }>(
      `SELECT CASE WHEN "winnerId" = "whiteId" THEN "blackId" ELSE "whiteId" END AS "loserId"
       FROM games
       WHERE "seriesId" = $1 AND id < $2 AND status = 'finished' AND result IS DISTINCT FROM 'aborted'
       ORDER BY id DESC LIMIT $3`,
      [seriesId, gameId, count]
    );
    return rows.map((row) => row.loserId);
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
    score: SeriesScore & TimedScore,
    end: { winnerId: number | null; endReason: SeriesEndReason } | null
  ): Promise<SeriesSummary | null> {
    const { rows } = await tx.query<SummaryRow>(
      `WITH s AS (
         UPDATE series SET "playerOneHalfPoints" = $2, "playerTwoHalfPoints" = $3, "gamesPlayed" = $4,
           status = $5, "winnerId" = $6, "endReason" = $7, "endedAt" = CASE WHEN $5 = 'finished' THEN now() END,
           "playerOnePoints" = $8, "playerTwoPoints" = $9, "playerOneStreak" = $10, "playerTwoStreak" = $11,
           "noShows" = $12
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
        score.playerOnePoints,
        score.playerTwoPoints,
        score.playerOneStreak,
        score.playerTwoStreak,
        score.noShows,
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
  locked?: SeriesRow | null,
  /**
   * `noShowUserId`: the player who never made their first move, when that
   * ended the game (timed matches count these); `now` is when it ended
   */
  options: { noShowUserId?: number | null; now?: Date } = {}
): Promise<SeriesSummary | null> {
  if (game.seriesId === null) return null;
  const series =
    locked && locked.id === game.seriesId ? locked : await seriesRepository.lockSummary(tx, game.seriesId);
  if (!series) return null;
  if (series.status === "active" && isTimedMatch(series)) {
    const played = { whiteId: game.whiteId, blackId: game.blackId, result };
    const noShowUserId = options.noShowUserId ?? null;
    const score = scoreTimedGame(scoreGame(series, played), played, noShowUserId !== null);
    // Who missed the no-show games in a row this one ends, for an abandoned
    // match; the earlier ones are read from the games, so it holds whichever
    // instance ended them
    const absentees =
      noShowUserId !== null && score.noShows >= MAX_NO_SHOWS
        ? [noShowUserId, ...(await seriesRepository.noShowLosers(tx, series.id, game.id, MAX_NO_SHOWS - 1))]
        : [];
    const end = timedMatchEnd(
      score,
      { endsAt: series.endsAt!.getTime(), time: series.time },
      (options.now ?? new Date()).getTime(),
      absentees
    );
    return seriesRepository.saveScore(tx, series.id, score, end);
  }
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
 * For a rematch of a series game: whether the series' games are rated (a
 * game of it may have been made unrated only because a player never moved,
 * and that mustn't carry over), and who plays whom in its next game, `next`
 * being null when the series is over (the rematch is then an ordinary
 * game). Null for a game outside a series. Locks the series.
 */
export async function nextSeriesGame(
  tx: Queryable,
  game: LiveGame
): Promise<{
  rated: boolean;
  next: { seriesId: number; number: number; whiteId: number; blackId: number } | null;
} | null> {
  if (game.seriesId === null) return null;
  const series = await seriesRepository.lock(tx, game.seriesId);
  if (!series) return null;
  if (series.status !== "active") return { rated: series.rated, next: null };
  const number = series.gamesPlayed + 1;
  return { rated: series.rated, next: { seriesId: series.id, number, ...seriesColors(series, number) } };
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

/** How long past a timed match's end this instance keeps sweeping for it (see needsTimedSweep) */
const TIMED_SWEEP_GRACE_MS = 2 * 60_000;
/**
 * How often an instance looks for timed matches it doesn't know of (another
 * instance created them): a match whose instance went away waits at most
 * this long for its next game. Well over the 5 minutes that kept the
 * database awake for one idle tab (see SERIES_SWEEP_MS in jobs.ts).
 */
export const TIMED_MATCH_REFRESH_MS = 10 * 60_000;

/** For what a timed match does by itself: start its next game, and play every game out */
export const timedMatchError = (what = "The next game of a timed match starts by itself") =>
  new AppError(what, "TIMED_MATCH_GAME", 409);

/** What starting the next game of a timed match did (see SeriesService.startNextGame). */
type NextGameStep =
  | { kind: "started"; game: LiveGame; messages: { topic: string; message: object }[] }
  | { kind: "ended"; summary: SeriesSummary }
  | null;

export class SeriesService {
  constructor(
    private fastify: FastifyInstance,
    private hub: RealtimeHub
  ) {}

  /** Per timed match, the timer that starts its next game (NEXT_GAME_DELAY_MS after the last one) */
  private nextGameTimers = new Map<number, NodeJS.Timeout>();
  /** Until when this instance runs the timed-match sweep (ms) */
  private timedUntil = 0;
  /** When loadTimedMatches last ran (ms), and the read in flight */
  private timedLoadedAt = 0;
  private timedLoading: Promise<void> | null = null;

  /**
   * Whether the timed-match sweep has anything to do on this instance: a
   * timed match it created, continued or found in the database (at startup,
   * then every TIMED_MATCH_REFRESH_MS) hasn't been over for long. Keeps an
   * idle server from asking the database anything.
   *
   * Asked by the sweep's timer, so it also starts that refresh when it is
   * due: a match another instance created is then swept here too, should
   * that instance go away. Only while this instance has sockets attached
   * (as the series sweep), so a server nobody uses lets the database sleep;
   * a match whose players are all away waits for the next one to connect.
   */
  get needsTimedSweep(): boolean {
    if (Date.now() - this.timedLoadedAt >= TIMED_MATCH_REFRESH_MS && this.hub.attachedCount > 0) {
      void this.refreshTimedMatches();
    }
    return Date.now() < this.timedUntil;
  }

  /** Keeps the timed-match sweep running until a while after this end time. */
  noteTimedMatch(endsAt: Date): void {
    this.timedUntil = Math.max(this.timedUntil, Math.max(endsAt.getTime(), Date.now()) + TIMED_SWEEP_GRACE_MS);
  }

  /** Timed matches still on, whichever instance created them (at startup: a previous process's too). */
  async loadTimedMatches(): Promise<void> {
    this.timedLoadedAt = Date.now();
    // From series_timed_active_idx: only the active timed matches are read
    const { rows } = await this.fastify.pg.query<{ endsAt: Date | null }>(
      `SELECT MAX("endsAt") AS "endsAt" FROM series WHERE status = 'active' AND "matchMinutes" IS NOT NULL`
    );
    if (rows[0]?.endsAt) this.noteTimedMatch(rows[0].endsAt);
  }

  /** loadTimedMatches, once at a time (the read in flight, if any). Never throws. */
  refreshTimedMatches(): Promise<void> {
    this.timedLoading ??= this.loadTimedMatches()
      .catch((err) => this.fastify.log.error({ err }, "Reading the active timed matches failed"))
      .finally(() => {
        this.timedLoading = null;
      });
    return this.timedLoading;
  }

  /**
   * Starts the next game of a timed match NEXT_GAME_DELAY_MS from now (a
   * game of it has just ended). The sweep catches it if this instance goes
   * away first. Never throws.
   */
  scheduleNextGame(seriesId: number, endsAt: Date | null): void {
    if (endsAt) this.noteTimedMatch(endsAt);
    if (this.nextGameTimers.has(seriesId)) return;
    const timer = setTimeout(() => {
      this.nextGameTimers.delete(seriesId);
      void this.continueTimedMatch(seriesId);
    }, NEXT_GAME_DELAY_MS);
    timer.unref();
    this.nextGameTimers.set(seriesId, timer);
  }

  stop(): void {
    for (const timer of this.nextGameTimers.values()) clearTimeout(timer);
    this.nextGameTimers.clear();
  }

  /**
   * The timed matches between games for longer than NEXT_GAME_DELAY_MS
   * (their timer was on an instance that went away, or the next game
   * couldn't start): starts their next game, or ends them once the time is up.
   */
  async sweepTimedMatches(now = new Date()): Promise<void> {
    const { rows } = await this.fastify.pg.query<{ id: number }>(
      `SELECT s.id FROM series s
       WHERE s.status = 'active' AND s."matchMinutes" IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM games g WHERE g."seriesId" = s.id AND g.status = 'in_progress')
         AND COALESCE((SELECT MAX(g."endedAt") FROM games g WHERE g."seriesId" = s.id), s."createdAt") <= $1
       ORDER BY s."endsAt" LIMIT 50`,
      [new Date(now.getTime() - 2 * NEXT_GAME_DELAY_MS)]
    );
    for (const { id } of rows) await this.continueTimedMatch(id);
  }

  /** Starts a timed match's next game, or ends the match when its time is up. Never throws. */
  async continueTimedMatch(seriesId: number): Promise<void> {
    let step: NextGameStep;
    try {
      step = await this.fastify.pg.transact((tx) => this.startNextGame(tx, seriesId));
    } catch (err) {
      // A player went into another game between two of the match: the
      // sweep tries again until the time is up
      if (err instanceof AlreadyInGameError) return;
      this.fastify.log.error({ err, seriesId }, "Starting the next timed match game failed");
      return;
    }
    if (!step) return;
    if (step.kind === "ended") {
      await this.ended(step.summary);
      return;
    }
    const { game, messages } = step;
    this.fastify.liveGames.watchDeadline(game.id, game.deadlineAt);
    // As a rematch does: the finished game's page moves on to the new one
    await Promise.all(messages.map(({ topic, message }) => this.hub.publish(topic, message))).catch((err) =>
      this.fastify.log.error({ err, seriesId }, "Failed to publish the next timed match game")
    );
  }

  private async startNextGame(tx: Queryable, seriesId: number): Promise<NextGameStep> {
    // Locks in a rematch's order: the last game's row, queue rows, the
    // series, the players (createGame)
    const { rows: last } = await tx.query<{ id: number; whiteId: number; blackId: number; status: string }>(
      `SELECT id, "whiteId", "blackId", status FROM games WHERE "seriesId" = $1 ORDER BY id DESC LIMIT 1 FOR UPDATE`,
      [seriesId]
    );
    const previous = last[0];
    if (!previous || previous.status === "in_progress") return null;
    // The match goes before a search either player started between games.
    // Only if a game does start, though: when the match ends here instead
    // (or there is nothing to do), rolling back to the savepoint keeps the
    // search. That also lets go of the queue rows and the series row, which
    // were locked after it, so ending the match locks the series again
    // (still after the last game's row, which stays locked)
    await tx.query(`SAVEPOINT next_game`);
    await tx.query(`DELETE FROM matchmaking WHERE "userId" = ANY($1)`, [[previous.whiteId, previous.blackId]]);
    const keepSearches = () => tx.query(`ROLLBACK TO SAVEPOINT next_game`);
    const series = await seriesRepository.lockSummary(tx, seriesId);
    if (!series || series.status !== "active" || !isTimedMatch(series)) {
      await keepSearches();
      return null;
    }
    // Checked under the lock: the timer and the sweep may both get here
    if (await seriesRepository.hasGameInProgress(tx, seriesId)) {
      await keepSearches();
      return null;
    }
    const end = async (endReason: "time_up" | "abandoned"): Promise<NextGameStep> => {
      await keepSearches();
      // As it now is: a resignation may have got in while it wasn't locked
      const current = await seriesRepository.lockSummary(tx, seriesId);
      if (!current || current.status !== "active") return null;
      const winnerId = timedMatchWinner(current);
      return {
        kind: "ended",
        summary: (await seriesRepository.saveScore(tx, seriesId, current, { winnerId, endReason }))!,
      };
    };
    if (Date.now() >= lastGameStartAt(series.endsAt!.getTime(), series.time)) return end("time_up");
    // A block between the two ends the match where it stands
    const blocks = await blocksBetween(tx, series.playerOneId, series.playerTwoId);
    if (blocks.byFirst || blocks.bySecond) return end("abandoned");
    const number = series.gamesPlayed + 1;
    const colors = seriesColors(series, number);
    const game = await createGame(tx, {
      ...colors,
      time: series.time,
      increment: series.increment,
      odds: seriesOdds(series, colors),
      rated: series.rated,
      openingId: series.openingId,
      series: { id: series.id, game: number },
    });
    return { kind: "started", game, messages: await linkNextGame(tx, previous.id, game) };
  }

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
    // A timed match never waits between games for long: resigning it
    // resigns the game being played first
    const current = await seriesRepository.find(this.fastify.pg, seriesId);
    let resignedGame = false;
    if (
      current &&
      isTimedMatch(current) &&
      current.status === "active" &&
      (current.playerOneId === userId || current.playerTwoId === userId)
    ) {
      const { rows } = await this.fastify.pg.query<{ id: number }>(
        `SELECT id FROM games WHERE "seriesId" = $1 AND status = 'in_progress' LIMIT 1`,
        [seriesId]
      );
      if (rows[0]) {
        await this.fastify.liveGames.resign(rows[0].id, userId);
        resignedGame = true;
      }
    }
    const result = await this.fastify.pg.transact(async (tx) => {
      const series = await seriesRepository.lockSummary(tx, seriesId);
      if (!series) throw seriesNotFound();
      if (series.playerOneId !== userId && series.playerTwoId !== userId) {
        throw new AppError("You are not playing in this series", "NOT_IN_SERIES", 403);
      }
      if (series.status !== "active") {
        // The game just resigned ended the match (its time was up): that
        // game's end announced it, and this is the match as it ended
        if (resignedGame) return { summary: toSeriesSummary(series), endedHere: false };
        throw new AppError("The series is already over", "SERIES_OVER", 409);
      }
      if (await seriesRepository.hasGameInProgress(tx, seriesId)) {
        throw new AppError("Finish the current game first", "SERIES_GAME_IN_PROGRESS", 409);
      }
      const winnerId = series.playerOneId === userId ? series.playerTwoId : series.playerOneId;
      const summary = (await seriesRepository.saveScore(tx, seriesId, series, { winnerId, endReason: "resignation" }))!;
      return { summary, endedHere: true };
    });
    if (result.endedHere) await this.ended(result.summary);
    return result.summary;
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
      AND status = 'finished' AND result IS DISTINCT FROM 'aborted' AND "botId" IS NULL
      -- Table games (migration 040) aren't part of head-to-head
      AND NOT "tableGame"`;
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
