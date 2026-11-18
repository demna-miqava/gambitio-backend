import type { FastifyInstance } from "fastify";
import type { Chess } from "chess.js";
import type { TxClient } from "../db.js";
import { isLiveGame, type LiveGame, type RatingChanges } from "../models/Game.js";
import { gameRepository, saveMoveStatement, type SavedMove } from "../repositories/gameRepository.js";
import {
  applyMoveTo,
  takebackPlies,
  timeoutOutcome,
  undoMoves,
  type MoveInput,
  type Outcome,
  winFor,
} from "../game/engine.js";
import {
  activeColor,
  addTime,
  afterMove,
  chargeMove,
  deadline,
  GIVE_TIME_MS,
  isClockRunning,
  isFlagged,
  pausedDeadline,
  remainingAt,
  resumeShift,
  type ClockState,
  type MoveTiming,
} from "../game/clock.js";
import { STARTING_FEN } from "../game/engine.js";
import { colorOf, createGame, finishGame, matchFoundData, opponentOf } from "./gameService.js";
import { AppError } from "../errors/AppError.js";
import { activeGameMessage, topics, type RealtimeHub } from "../realtime/hub.js";
import { blocksBetween } from "../repositories/blockRepository.js";
import { invalidateStats } from "./statsService.js";
import { PositionCache } from "../game/positionCache.js";
import {
  nextSeriesGame,
  recordSeriesResult,
  seriesRepository,
  type SeriesSummary,
} from "./seriesService.js";
import {
  lockTournamentPlayers,
  recordTournamentResult,
  type TournamentGameResult,
} from "./tournamentService.js";

/** What a game transaction does once it has committed. */
interface TxEffects {
  /** Messages to publish */
  out: { topic: string; message: object }[];
  /** Players whose cached stats are now stale */
  staleStats: number[];
  /** Games that ended */
  ended: number[];
  /** Games whose deadline was set or moved */
  deadlines: { gameId: number; at: Date | null }[];
  /** Positions to cache for the next move (see PositionCache) */
  positions: { gameId: number; chess: Chess; pgn: string; ply: number }[];
  /** Tournaments whose standings a finished game changed, with the game's two players */
  tournaments: { id: number; userIds: number[] }[];
  /**
   * The transaction's last statement, sent in the same simple query as
   * COMMIT to save a round trip. Only for a statement nothing else follows
   * (see saveMoveStatement).
   */
  finalStatement?: string;
}

/** How a move was timed: see LiveGameService.move. */
export interface LiveMoveTiming {
  receivedAt?: number;
  thinkMs?: number | undefined;
  ply?: number | undefined;
  /** The round trip the server measured to the mover (see RttProbe), if any */
  measuredRttMs?: number | undefined;
  /** What went into measuredRttMs, only for the lag log */
  rttSources?: { pingMs: number | undefined; tcpMs: number | undefined } | undefined;
}

/** A player's socket on this instance, as LiveGameService tracks it (see attachPlayer). */
export interface PlayerSocketHandle {
  /** Stops per-socket work (the RTT probe) once the game is over */
  stop(): void;
}

/**
 * Claimed delay beyond what the server can measure that gets a log line
 * (at most every LAG_LOG_EVERY_PLIES per player and game), to tune the lag
 * constants in clock.ts and spot accounts that keep claiming it.
 */
const LAG_LOG_EXCESS_MS = 300;
const LAG_LOG_EVERY_PLIES = 40;

/**
 * A game's spectator count goes out at most once per this long, the latest
 * count at the end of the window, so a crowd joining and leaving doesn't
 * send everyone a message per change.
 */
const SPECTATOR_COUNT_EVERY_MS = 2_000;

/** Fires a moment after the deadline, so the clock has surely run out. */
const DEADLINE_SLACK_MS = 20;
/** A deadline timer whose resolve failed tries again after this long. */
const DEADLINE_RETRY_MS = 5_000;
/**
 * How long the clock sweep keeps running, with no timer armed here, after
 * a failed read of the live games' deadlines (see armLiveDeadlines).
 */
const UNREAD_DEADLINES_SWEEP_MS = 5 * 60_000;

function clockOf(game: LiveGame): ClockState {
  return {
    whiteMs: game.whiteTimeLeftMs ?? (game.whiteTime ?? game.time) * 1000,
    blackMs: game.blackTimeLeftMs ?? (game.blackTime ?? game.time) * 1000,
    lastMoveAt: (game.lastMoveAt ?? game.createdAt).getTime(),
    ply: game.numMoves,
    whiteLagBudgetMs: game.whiteLagBudgetMs,
    blackLagBudgetMs: game.blackLagBudgetMs,
  };
}

/** Redis set of the sockets watching a game (not its players); see RealtimeHub.addMembership. */
export const spectatorsKey = (gameId: number) => `spectators:game:${gameId}`;

const notFound = () => new AppError("Game not found", "GAME_NOT_FOUND", 404);
const notAPlayer = () => new AppError("You are not a player in this game", "NOT_A_PLAYER", 403);
const gameOver = () => new AppError("The game is over", "GAME_OVER", 409);
// Bot games are played in the browser and stored once finished; there is
// nothing live about them (no moves, clock or rematch here)
const botGame = () => new AppError("This game was played against the computer", "BOT_GAME", 409);
const takebackNotAllowed = () =>
  new AppError("There is no move of yours to take back yet", "TAKEBACK_NOT_ALLOWED", 409);
const drawDeclined = () =>
  new AppError("Your draw offer was declined; you can offer again after your next move", "DRAW_DECLINED", 409);
const rematchAlreadyRequested = () =>
  new AppError("You can only ask for a rematch once per game", "REMATCH_ALREADY_REQUESTED", 409);
// A tournament pairs its own games and scores them as played: no rematch,
// no takeback, no abort, no time given
const tournamentGame = (what: string) =>
  new AppError(`${what} isn't available in a tournament game`, "TOURNAMENT_GAME", 409);

/**
 * All live-game rules. The server owns the position, the clock and the
 * result; clients only send intents (a move, resign, offer draw...).
 *
 * Every action runs in a transaction that starts by locking the game row, so
 * actions on one game are serialized across all server instances. Messages
 * are published only after the transaction commits.
 */
export class LiveGameService {
  constructor(
    private fastify: FastifyInstance,
    private hub: RealtimeHub
  ) {}

  /** Parsed positions of live games, so a move doesn't replay the game */
  private positions = new PositionCache();
  /** One timer per live game this instance knows about, set for its deadline */
  private deadlineTimers = new Map<number, { at: number; timer: NodeJS.Timeout }>();
  private deadlineTimersEnabled = false;
  /** Set while the startup read of live deadlines hasn't succeeded (see armLiveDeadlines) */
  private liveDeadlinesUnread = false;
  /** Until when the clock sweep runs regardless (see needsClockSweep) */
  private sweepUntil = 0;
  /** Players' sockets on this instance, by game: the games to pause on shutdown */
  private playerSockets = new Map<number, Set<PlayerSocketHandle>>();
  /** Set by pauseForShutdown: games stay paused, whatever happens until the process exits */
  private shuttingDown = false;
  /** Games paused before this moment were paused by a server that is gone (see resumePausedGames) */
  private readonly startedAt = Date.now();
  /** Per game and player, the ply of the last lag log line (see LAG_LOG_EXCESS_MS) */
  private lagLogged = new Map<string, number>();
  /** Per game, the spectator-count throttle window (see SPECTATOR_COUNT_EVERY_MS) */
  private spectatorWindows = new Map<number, { timer: NodeJS.Timeout; pending: boolean }>();

  private async run(gameId: number, fn: (tx: TxClient, game: LiveGame, fx: TxEffects) => Promise<void>) {
    const fx: TxEffects = { out: [], staleStats: [], ended: [], deadlines: [], positions: [], tournaments: [] };
    if (!Number.isSafeInteger(gameId) || gameId <= 0) throw notFound();
    const tx = await this.fastify.pg.connect();
    let broken = false;
    try {
      const locked = await gameRepository.beginAndLock(tx, gameId);
      if (!locked) throw notFound();
      if (!isLiveGame(locked)) throw botGame();
      // Safety net: whatever the action, a game paused for a shutdown is
      // resumed first, so nothing (a deadline timer, the sweep) can flag it
      // for time the server was down. Not while this server is the one
      // shutting down: its games must stay paused until it is gone.
      const game = locked.pausedAt && locked.status === "in_progress" && !this.shuttingDown
        ? await this.resumeLocked(tx, locked, fx)
        : locked;
      await fn(tx, game, fx);
      // One round trip for the last write and the commit. An error in the
      // statement skips the COMMIT and lands in the catch below.
      await tx.query(fx.finalStatement ? `${fx.finalStatement}; COMMIT` : "COMMIT");
    } catch (error) {
      await tx.query("ROLLBACK").catch(() => {
        broken = true; // don't hand a connection in an unknown state back to the pool
      });
      throw error;
    } finally {
      tx.release(broken);
    }
    // The transaction has committed: from here on nothing may throw, or the
    // client gets an error for an action that actually happened.
    for (const id of fx.ended) {
      this.positions.drop(id);
      this.clearDeadline(id);
      this.forgetGame(id);
    }
    // A move that ends the game also set a new deadline: no timer for it
    for (const { gameId: id, at } of fx.deadlines) {
      if (!fx.ended.includes(id)) this.watchDeadline(id, at);
    }
    for (const { gameId: id, chess, pgn, ply } of fx.positions) {
      if (!fx.ended.includes(id)) this.positions.commit(id, chess, pgn, ply);
    }
    // Before publishing: players refetch their stats as soon as they hear
    // the game ended
    if (fx.staleStats.length > 0) {
      await invalidateStats(this.fastify.redis, fx.staleStats).catch((err) =>
        this.fastify.log.error({ err }, "Failed to clear stats cache")
      );
    }
    // Not one after another: publish() delivers to this instance's sockets
    // before it returns, in call order, and the Redis PUBLISHes all go out
    // on one connection in that same order, so every topic still gets its
    // messages in order while the round trips overlap.
    await Promise.all(
      fx.out.map(({ topic, message }) =>
        this.hub
          .publish(topic, message)
          .catch((err) => this.fastify.log.error({ err, topic }, "Failed to publish game update"))
      )
    );
    // The lobby gets the new standings (throttled; never throws)
    for (const { id, userIds } of fx.tournaments) this.fastify.tournaments.noteChanged(id, userIds);
  }

  /**
   * Ends a game's pause (see pauseForShutdown) inside its locked transaction:
   * lastMoveAt and the deadline move forward by resumeShift, and the
   * deadline timer is re-armed once this commits.
   */
  private async resumeLocked(tx: TxClient, game: LiveGame, fx: TxEffects): Promise<LiveGame> {
    const lastMoveAt = clockOf(game).lastMoveAt;
    const shift = resumeShift(
      { pausedAt: game.pausedAt!.getTime(), lastMoveAt, deadlineAt: game.deadlineAt?.getTime() ?? null },
      Date.now()
    );
    const resumed = {
      lastMoveAt: new Date(lastMoveAt + shift),
      deadlineAt: game.deadlineAt && new Date(game.deadlineAt.getTime() + shift),
    };
    await gameRepository.resume(tx, game.id, resumed);
    fx.deadlines.push({ gameId: game.id, at: resumed.deadlineAt });
    this.fastify.log.info({ gameId: game.id, shiftMs: shift }, "Resumed a paused game");
    return { ...game, ...resumed, pausedAt: null };
  }

  /**
   * Registers a player's socket for a game in progress on this instance (so
   * a shutdown pauses the game; see pauseForShutdown). `handle.stop()` is
   * called when the game ends here. Returns the function to call when the
   * socket closes.
   */
  attachPlayer(gameId: number, handle: PlayerSocketHandle): () => void {
    let set = this.playerSockets.get(gameId);
    if (!set) this.playerSockets.set(gameId, (set = new Set()));
    set.add(handle);
    return () => {
      const current = this.playerSockets.get(gameId);
      if (!current?.delete(handle)) return;
      if (current.size === 0) this.playerSockets.delete(gameId);
    };
  }

  /** Games with a player's socket on this instance (for tests and logs). */
  get playedGameIds(): number[] {
    return [...this.playerSockets.keys()];
  }

  /** Drops what this instance keeps for a game that has ended. */
  private forgetGame(gameId: number): void {
    const sockets = this.playerSockets.get(gameId);
    this.playerSockets.delete(gameId);
    for (const handle of sockets ?? []) handle.stop();
    this.lagLogged.delete(`${gameId}:white`);
    this.lagLogged.delete(`${gameId}:black`);
  }

  /**
   * Pauses, for a shutdown (SIGTERM: a deploy or restart), every game in
   * progress with a player's socket on this instance, in one UPDATE, so the
   * side to move isn't charged the downtime. Must run before the sockets
   * close. From then on this instance never resumes a game.
   *
   * A game resumes (resumeShift: lastMoveAt and the deadline move forward
   * by the pause, at most MAX_PAUSE_MS):
   * - when one of its players connects again (getState), on whichever
   *   instance that is: the usual way, seconds later;
   * - at the next startup (resumePausedGames), for games paused before it;
   * - in any action's transaction (run), as a safety net.
   * Until then a deadline timer or the sweep only decides it once even the
   * longest resume would have passed (pausedDeadline).
   *
   * Overlapping servers: with BACKEND_GENERATION raised (worker/index.ts)
   * the new generation starts while the old one still runs, and the old one
   * pauses its games after the new one has started. Startup only resumes
   * games paused before it started, so those stay paused until their
   * players reconnect to the new servers. The same holds with several
   * instances (BACKEND_INSTANCES): a game's sockets are all on one, which
   * pauses only its own games, and the others leave them paused.
   *
   * A crash, or a kill without SIGTERM, pauses nothing: those games lose the
   * downtime from the clock of the side to move, as before.
   */
  async pauseForShutdown(): Promise<number> {
    this.shuttingDown = true;
    const ids = this.playedGameIds;
    if (ids.length === 0) return 0;
    const paused = await gameRepository.pause(this.fastify.pg, ids, new Date());
    this.fastify.log.info({ paused }, "Paused games for shutdown");
    return paused;
  }

  /**
   * Resumes the games a previous server paused when it shut down (games
   * paused after this one started belong to a server that is still running;
   * see pauseForShutdown). Runs at startup, before the live games' timers are
   * armed (armLiveDeadlines).
   */
  async resumePausedGames(): Promise<void> {
    for (const id of await gameRepository.findPausedIds(this.fastify.pg, new Date(this.startedAt))) {
      // The resume itself is run's safety net
      await this.run(id, async () => {}).catch((err) =>
        this.fastify.log.error({ err, gameId: id }, "Resuming a paused game failed")
      );
    }
  }

  /**
   * Turns on per-game deadline timers (off in tests, which drive the clock
   * by hand). Each live game gets a timer for the moment its clock runs out
   * or its first-move window closes, so the database isn't polled to find
   * them. Arms timers for the games already in progress.
   */
  async startDeadlineTimers(): Promise<void> {
    // On before anything can fail, so a failed startup read never leaves
    // every later watchDeadline a no-op. The resumes arm their own timers.
    this.deadlineTimersEnabled = true;
    // Before the read, so it sees the moved deadlines. A failed resume
    // leaves the game paused: its timer (resolveDeadline) or its players'
    // reconnect resumes it later.
    await this.resumePausedGames().catch((err) =>
      this.fastify.log.error({ err }, "Resuming paused games failed")
    );
    await this.armLiveDeadlines().catch((err) =>
      this.fastify.log.error({ err }, "Reading live game deadlines failed; the clock sweep covers them")
    );
  }

  /**
   * Arms a timer for every live game. If the read fails, the clock sweep
   * runs for a while (needsClockSweep) and retries it (src/jobs.ts), so
   * those games are still decided.
   */
  async armLiveDeadlines(): Promise<void> {
    try {
      const live = await gameRepository.findLiveDeadlines(this.fastify.pg);
      this.liveDeadlinesUnread = false;
      for (const { id, deadlineAt } of live) this.watchDeadline(id, deadlineAt);
    } catch (err) {
      this.liveDeadlinesUnread = true;
      this.sweepUntil = Date.now() + UNREAD_DEADLINES_SWEEP_MS;
      throw err;
    }
  }

  /** True until armLiveDeadlines has read the live games once (after a failed read). */
  get liveDeadlinesPending(): boolean {
    return this.liveDeadlinesUnread;
  }

  /**
   * Whether the clock sweep (src/jobs.ts) has anything to do for this
   * instance: games with a timer here, games with a player's socket here,
   * or a failed startup read of the live games. Nothing of that for an
   * idle tab, so it doesn't keep the database awake.
   */
  get needsClockSweep(): boolean {
    return this.deadlineTimers.size > 0 || this.playerSockets.size > 0 || Date.now() < this.sweepUntil;
  }

  stopDeadlineTimers(): void {
    this.deadlineTimersEnabled = false;
    for (const id of [...this.deadlineTimers.keys()]) this.clearDeadline(id);
  }

  /** Stops every timer this service holds (app shutdown). */
  stop(): void {
    this.stopDeadlineTimers();
    for (const { timer } of this.spectatorWindows.values()) clearTimeout(timer);
    this.spectatorWindows.clear();
    for (const id of this.playedGameIds) {
      for (const handle of this.playerSockets.get(id) ?? []) handle.stop();
    }
  }

  /** Live games with a deadline timer on this instance. */
  get watchedGameCount(): number {
    return this.deadlineTimers.size;
  }

  /**
   * (Re)arms the game's deadline timer. Called after every committed change
   * to a deadline, including games created elsewhere (matchmaking,
   * challenges). A timer that fires for a deadline that has since moved
   * (a move made on another instance) finds that out and re-arms.
   */
  watchDeadline(gameId: number, at: Date | null): void {
    if (!this.deadlineTimersEnabled) return;
    if (!at) return this.clearDeadline(gameId);
    const when = at.getTime();
    if (this.deadlineTimers.get(gameId)?.at === when) return;
    this.armDeadline(gameId, when, Math.max(0, when - Date.now()) + DEADLINE_SLACK_MS);
  }

  /**
   * Sets the game's timer to resolve its deadline (`when`) in `delayMs`. A
   * resolve that fails (a transient database error, a lock timeout) tries
   * again after DEADLINE_RETRY_MS, unless the timer was re-armed meanwhile.
   */
  private armDeadline(gameId: number, when: number, delayMs: number): void {
    this.clearDeadline(gameId);
    const timer = setTimeout(() => {
      this.deadlineTimers.delete(gameId);
      this.resolveDeadline(gameId).catch((err) => {
        this.fastify.log.error({ err, gameId }, "Resolving a game deadline failed; retrying");
        if (this.deadlineTimersEnabled && !this.deadlineTimers.has(gameId)) {
          this.armDeadline(gameId, when, DEADLINE_RETRY_MS);
        }
      });
    }, delayMs);
    timer.unref();
    this.deadlineTimers.set(gameId, { at: when, timer });
  }

  private clearDeadline(gameId: number): void {
    const entry = this.deadlineTimers.get(gameId);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.deadlineTimers.delete(gameId);
  }

  /**
   * Full state for a (re)connecting client. A player coming back to a game
   * paused for a shutdown resumes it first (see pauseForShutdown), and an
   * expired clock is resolved. Pending draw offers, takeback requests and
   * rematch offers are between the players, so spectators don't see them.
   */
  async getState(gameId: number, viewerId: number) {
    let game = await gameRepository.findById(this.fastify.pg, gameId);
    if (!game) throw notFound();
    // Bot games aren't opened as live games
    if (!isLiveGame(game)) throw botGame();
    const resume = game.pausedAt !== null && colorOf(game, viewerId) !== null && !this.shuttingDown;
    // Only a game whose deadline has passed needs the locking transaction
    if (resume || isPastDeadline(game, Date.now())) {
      // The resume is run's safety net
      if (resume) await this.run(gameId, async () => {});
      await this.resolveDeadline(gameId);
      game = await gameRepository.findById(this.fastify.pg, gameId);
      if (!game || !isLiveGame(game)) throw notFound();
    }
    const isPlayer = colorOf(game, viewerId) !== null;
    const series =
      game.seriesId !== null ? await seriesRepository.summary(this.fastify.pg, game.seriesId) : null;
    // A game still paused (a spectator's view) shows the clocks as they
    // stood when it was paused
    const now = Date.now();
    const clockAt = game.pausedAt ? Math.min(now, game.pausedAt.getTime()) : now;
    const clock = game.status === "in_progress" ? remainingAt(clockOf(game), clockAt) : null;
    return {
      type: "initial_game_state",
      data: {
        gameId: game.id,
        fen: game.fen ?? STARTING_FEN,
        pgn: game.pgn ?? "",
        whitePlayer: {
          id: game.whiteId,
          username: game.whiteUsername,
          rating: game.whiteRating,
          provisional: game.whiteProvisional,
          avatarUrl: game.whiteAvatarUrl,
        },
        blackPlayer: {
          id: game.blackId,
          username: game.blackUsername,
          rating: game.blackRating,
          provisional: game.blackProvisional,
          avatarUrl: game.blackAvatarUrl,
        },
        time: game.time,
        increment: game.increment,
        // Each side's starting clock when they differ (time odds); null otherwise
        whiteTime: game.whiteTime,
        blackTime: game.blackTime,
        rated: game.rated,
        status: game.status,
        numMoves: game.numMoves,
        isFinished: game.status === "finished",
        clockRunning: isClockRunning(game.numMoves),
        whiteTimeLeft: clock?.whiteMs ?? game.whiteTimeLeftMs,
        blackTimeLeft: clock?.blackMs ?? game.blackTimeLeftMs,
        drawOfferedBy: isPlayer ? game.drawOfferedBy : null,
        takebackRequestedBy: isPlayer ? game.takebackRequestedBy : null,
        rematchRequestedBy: isPlayer ? game.rematchRequestedBy : null,
        rematchGameId: game.rematchGameId,
        series,
        seriesGame: game.seriesGame,
        // Set for a game an arena tournament paired
        tournamentId: game.tournamentId,
        ...(game.status === "finished" && {
          result: game.result,
          reason: game.endReason,
          winnerId: game.winnerId,
          // An unrated game (time odds) has none, as when it ended
          ...(game.rated && {
            ratingChanges: {
              whiteRatingChange: game.whiteRatingChange ?? 0,
              blackRatingChange: game.blackRatingChange ?? 0,
              whiteNewRating: game.whiteRating + (game.whiteRatingChange ?? 0),
              blackNewRating: game.blackRating + (game.blackRatingChange ?? 0),
            },
          }),
        }),
      },
    };
  }

  /** Distinct users watching the game (players aren't counted). */
  async spectatorCount(gameId: number): Promise<number> {
    return this.hub.countMembers(spectatorsKey(gameId));
  }

  /**
   * Tells everyone on the game how many people are watching, at most once
   * per SPECTATOR_COUNT_EVERY_MS: a change within the window goes out at
   * its end, with the count as it is then, so the last change is always
   * sent. `count` is the current count if the caller just read it. Never
   * throws.
   */
  async publishSpectatorCount(gameId: number, count?: number): Promise<void> {
    const window = this.spectatorWindows.get(gameId);
    if (window) {
      window.pending = true;
      return;
    }
    this.openSpectatorWindow(gameId);
    await this.sendSpectatorCount(gameId, count);
  }

  private openSpectatorWindow(gameId: number): void {
    const timer = setTimeout(() => {
      const window = this.spectatorWindows.get(gameId);
      this.spectatorWindows.delete(gameId);
      if (!window?.pending) return;
      // The trailing send opens the next window
      this.openSpectatorWindow(gameId);
      void this.sendSpectatorCount(gameId);
    }, SPECTATOR_COUNT_EVERY_MS);
    timer.unref();
    this.spectatorWindows.set(gameId, { timer, pending: false });
  }

  private async sendSpectatorCount(gameId: number, known?: number): Promise<void> {
    try {
      const count = known ?? (await this.spectatorCount(gameId));
      await this.hub.publish(topics.game(gameId), { type: "spectators", count });
    } catch (err) {
      this.fastify.log.error({ err, gameId }, "Failed to publish spectator count");
    }
  }

  private async end(
    tx: TxClient,
    game: LiveGame,
    outcome: Outcome,
    clock: { whiteMs: number; blackMs: number } | null,
    fx: TxEffects,
    /** The player who never made their first move, when that ended a tournament game */
    noShowUserId: number | null = null
  ) {
    // The series row is locked before the players' rows (finishGame), the
    // same order a rematch takes them in; recordSeriesResult reuses the row
    const lockedSeries =
      game.seriesId !== null && game.status === "in_progress"
        ? await seriesRepository.lockSummary(tx, game.seriesId)
        : null;
    // So are the players' tournament rows, the order the pairing pass takes
    // them in (TournamentService.pair)
    const tournamentRows = game.status === "in_progress" ? await lockTournamentPlayers(tx, game) : [];
    // A tournament game that ends before both sides have moved (a no-show,
    // or a resignation on move one) still counts in the tournament, but it
    // wasn't a game of chess: it changes no ratings
    const played =
      game.tournamentId !== null && game.rated && game.numMoves < 2 && game.status === "in_progress"
        ? await gameRepository.makeUnrated(tx, game)
        : game;
    const finished = await finishGame(tx, played, outcome, clock);
    if (!finished) return;
    const series = await recordSeriesResult(tx, game, outcome.result, lockedSeries);
    const tournament = await recordTournamentResult(tx, game, outcome.result, tournamentRows, {
      noShowUserId,
      now: new Date(),
    });
    if (tournament) fx.tournaments.push({ id: tournament.tournamentId, userIds: [game.whiteId, game.blackId] });
    fx.staleStats.push(game.whiteId, game.blackId);
    fx.ended.push(game.id);
    fx.out.push({
      topic: topics.game(game.id),
      message: gameEndedMessage(outcome, finished, series, tournament),
    });
    for (const playerId of [game.whiteId, game.blackId]) {
      fx.out.push({ topic: topics.notifications(playerId), message: activeGameMessage(null) });
    }
  }

  /** The current position, from the cache when it matches the locked row. */
  private position(game: LiveGame) {
    return this.positions.checkout(game.id, game.pgn, game.numMoves);
  }

  /**
   * Plays a move. `receivedAt` is when the move reached this server (taken
   * before any database work, which shouldn't cost the player time),
   * `thinkMs` how long the player's own clock ran, if the client said, and
   * `measuredRttMs` the round trip the server measured to the player, if it
   * has one (see MAX_LAG_COMPENSATION_MS). `ply` is the position the client
   * made the move in, if it said: a move for another position (a takeback
   * accepted while the move was on its way) is rejected rather than played
   * where it lands.
   */
  async move(gameId: number, userId: number, input: MoveInput, timing: LiveMoveTiming = {}): Promise<void> {
    let rejected: { reason: string; fen: string; pgn: string } | null = null;
    // The position after the stored move, cached once the transaction commits
    let played: { chess: Chess; pgn: string; ply: number } | null = null;

    await this.run(gameId, async (tx, game, fx) => {
      if (game.status !== "in_progress") throw gameOver();
      const color = colorOf(game, userId);
      if (!color) throw notAPlayer();

      const state = clockOf(game);
      // Never before the previous move (whose time may have been taken later)
      const now = Math.max(timing.receivedAt ?? Date.now(), state.lastMoveAt);
      const moveTiming: MoveTiming = { thinkMs: timing.thinkMs, measuredRttMs: timing.measuredRttMs };
      if (activeColor(state.ply) !== color) {
        rejected = { reason: "Not your turn", fen: game.fen ?? "", pgn: game.pgn ?? "" };
        return;
      }
      if (timing.ply !== undefined && timing.ply !== game.numMoves) {
        rejected = { reason: "The position changed", fen: game.fen ?? "", pgn: game.pgn ?? "" };
        return;
      }
      // A first move that arrives after its deadline doesn't count: the game
      // ends as its timer would have ended it (aborted; in a tournament the
      // late player loses it and is paused, so a move sent in the moment
      // before the timer fires can't turn a no-show into a game that scores
      // nothing)
      if (!isClockRunning(state.ply) && game.deadlineAt && game.deadlineAt.getTime() <= now) {
        await this.endAtDeadline(tx, game, now, fx);
        return;
      }
      const chess = this.position(game);
      this.noteLag(game, userId, state, now, timing);
      if (isFlagged(state, now, moveTiming)) {
        await this.end(tx, game, timeoutOutcome(chess, color), remainingAt(state, now), fx);
        return;
      }

      const result = applyMoveTo(chess, game.pgn ?? "", game.numMoves, input);
      if (!result.ok) {
        // An illegal move leaves the position as it was
        played = { chess, pgn: game.pgn ?? "", ply: game.numMoves };
        rejected = { reason: result.reason, fen: game.fen ?? "", pgn: game.pgn ?? "" };
        return;
      }

      const clock = afterMove(state, now, game.increment * 1000, moveTiming);
      // Moving declines the opponent's pending draw offer
      const drawOfferedBy = game.drawOfferedBy === userId ? userId : null;
      const deadlineAt = new Date(deadline(clock));
      const update: SavedMove = {
        fen: result.fen,
        pgn: result.pgn,
        numMoves: result.ply,
        whiteTimeLeftMs: clock.whiteMs,
        blackTimeLeftMs: clock.blackMs,
        lastMoveAt: new Date(clock.lastMoveAt),
        deadlineAt,
        drawOfferedBy,
        // A player whose offer was declined may offer again once they've moved
        drawDeclinedFor: game.drawDeclinedFor === userId ? null : game.drawDeclinedFor,
        whiteLagBudgetMs: clock.whiteLagBudgetMs ?? game.whiteLagBudgetMs,
        blackLagBudgetMs: clock.blackLagBudgetMs ?? game.blackLagBudgetMs,
      };
      // A game-ending move has more to write; any other goes out with COMMIT
      if (result.outcome) await gameRepository.saveMove(tx, gameId, update);
      else fx.finalStatement = saveMoveStatement(tx, gameId, update);
      played = { chess, pgn: result.pgn, ply: result.ply };
      fx.deadlines.push({ gameId, at: deadlineAt });

      fx.out.push({
        topic: topics.game(gameId),
        message: {
          type: "move",
          move: result.move,
          // No PGN: it grows with every move and the client already has the
          // moves. A client whose board doesn't end up at this FEN asks for
          // the full state ("sync").
          fen: result.fen,
          userId,
          moveNumber: result.ply,
          clockRunning: isClockRunning(clock.ply),
          whiteTimeLeft: clock.whiteMs,
          blackTimeLeft: clock.blackMs,
        },
      });

      if (result.outcome) {
        const updated = { ...game, numMoves: result.ply, drawOfferedBy };
        await this.end(tx, updated, result.outcome, clock, fx);
        played = null; // nothing left to play
      }
    });

    // Committed: keep the position for the next move
    const kept = played as { chess: Chess; pgn: string; ply: number } | null;
    if (kept) this.positions.commit(gameId, kept.chess, kept.pgn, kept.ply);

    if (rejected) {
      const r = rejected as { reason: string; fen: string; pgn: string };
      await this.hub.publish(topics.gameUser(gameId, userId), {
        type: "move_rejected",
        message: r.reason,
        fen: r.fen,
        pgn: r.pgn,
      });
    }
  }

  /**
   * Logs a move that claims much more network delay than the server
   * measured (LAG_LOG_EXCESS_MS), at most once per LAG_LOG_EVERY_PLIES for
   * each player of a game.
   */
  private noteLag(game: LiveGame, userId: number, state: ClockState, now: number, timing: LiveMoveTiming): void {
    const charge = chargeMove(state, now, { thinkMs: timing.thinkMs, measuredRttMs: timing.measuredRttMs });
    if (charge.claimedLagMs - charge.freeMs <= LAG_LOG_EXCESS_MS) return;
    const key = `${game.id}:${activeColor(state.ply)}`;
    const last = this.lagLogged.get(key);
    if (last !== undefined && state.ply - last < LAG_LOG_EVERY_PLIES) return;
    // Entries are dropped when a game ends here; this bounds the ones for
    // games that ended elsewhere
    if (this.lagLogged.size >= 10_000) this.lagLogged.clear();
    this.lagLogged.set(key, state.ply);
    this.fastify.log.info(
      {
        gameId: game.id,
        userId,
        ply: state.ply,
        claimedMs: charge.claimedLagMs,
        measuredMs: timing.measuredRttMs ?? null,
        pingMs: timing.rttSources?.pingMs ?? null,
        tcpMs: timing.rttSources?.tcpMs ?? null,
        forgivenMs: charge.forgivenMs,
        lagBudgetMs: charge.lagBudgetMs,
      },
      "Move claims more network delay than measured"
    );
  }

  async resign(gameId: number, userId: number): Promise<void> {
    await this.run(gameId, async (tx, game, fx) => {
      if (game.status !== "in_progress") throw gameOver();
      const color = colorOf(game, userId);
      if (!color) throw notAPlayer();
      const now = Date.now();
      // A flag that has already fallen decides the game, not a later resignation
      if (isPastDeadline(game, now)) {
        await this.endAtDeadline(tx, game, now, fx);
        return;
      }
      const winner = color === "white" ? "black" : "white";
      const clock = remainingAt(clockOf(game), now);
      await this.end(tx, game, { result: winFor(winner), reason: "resignation" }, clock, fx);
    });
  }

  /** Allowed until both players have made their first move. */
  async abort(gameId: number, userId: number): Promise<void> {
    await this.run(gameId, async (tx, game, fx) => {
      if (game.status !== "in_progress") throw gameOver();
      if (!colorOf(game, userId)) throw notAPlayer();
      if (game.tournamentId !== null) throw tournamentGame("Aborting");
      if (game.numMoves >= 2) {
        throw new AppError("The game can no longer be aborted", "ABORT_NOT_ALLOWED", 409);
      }
      await this.end(tx, game, { result: "aborted", reason: "aborted" }, null, fx);
    });
  }

  async offerDraw(gameId: number, userId: number): Promise<void> {
    await this.run(gameId, async (tx, game, fx) => {
      if (game.status !== "in_progress") throw gameOver();
      if (!colorOf(game, userId)) throw notAPlayer();
      const opponentId = opponentOf(game, userId);
      const now = Date.now();
      if (isPastDeadline(game, now)) {
        await this.endAtDeadline(tx, game, now, fx);
        return;
      }

      // Both players offering means both agree
      if (game.drawOfferedBy === opponentId) {
        const clock = remainingAt(clockOf(game), now);
        await this.end(tx, game, { result: "draw", reason: "draw_agreement" }, clock, fx);
        return;
      }
      if (game.drawOfferedBy === userId) return;
      if (game.drawDeclinedFor === userId) throw drawDeclined();

      await gameRepository.setDrawOffer(tx, gameId, userId);
      fx.out.push({ topic: topics.gameUser(gameId, opponentId), message: { type: "draw_offer" } });
    });
  }

  async respondToDraw(gameId: number, userId: number, accepted: boolean): Promise<void> {
    await this.run(gameId, async (tx, game, fx) => {
      if (game.status !== "in_progress") throw gameOver();
      if (!colorOf(game, userId)) throw notAPlayer();
      const now = Date.now();
      if (isPastDeadline(game, now)) {
        await this.endAtDeadline(tx, game, now, fx);
        return;
      }
      const offererId = opponentOf(game, userId);
      // Only the opponent of whoever offered can answer
      if (game.drawOfferedBy !== offererId) {
        throw new AppError("There is no draw offer to answer", "NO_DRAW_OFFER", 409);
      }

      if (accepted) {
        const clock = remainingAt(clockOf(game), now);
        await this.end(tx, game, { result: "draw", reason: "draw_agreement" }, clock, fx);
      } else {
        // The offerer can't offer again until they have moved (DRAW_DECLINED)
        await gameRepository.declineDraw(tx, gameId, offererId);
        fx.out.push({
          topic: topics.gameUser(gameId, offererId),
          message: { type: "draw_response", accepted: false, userId },
        });
      }
    });
  }

  /**
   * Asks the opponent to take back the user's last move (see takebackPlies).
   * The opponent having asked too means both agree. After a decline the user
   * can't ask again until a move is made (TAKEBACK_DECLINED).
   */
  async requestTakeback(gameId: number, userId: number): Promise<void> {
    await this.run(gameId, async (tx, game, fx) => {
      if (game.status !== "in_progress") throw gameOver();
      const color = colorOf(game, userId);
      if (!color) throw notAPlayer();
      if (game.tournamentId !== null) throw tournamentGame("A takeback");
      const opponentId = opponentOf(game, userId);
      const now = Date.now();
      if (isPastDeadline(game, now)) {
        await this.endAtDeadline(tx, game, now, fx);
        return;
      }

      if (game.takebackRequestedBy === opponentId) {
        await this.takeBack(tx, game, opponentId, now, fx);
        return;
      }
      if (game.takebackRequestedBy === userId) return;
      if (game.takebackDeclinedFor === userId) {
        throw new AppError(
          "Your takeback request was declined; you can ask again after the next move",
          "TAKEBACK_DECLINED",
          409
        );
      }
      if (takebackPlies(game.numMoves, color) === null) throw takebackNotAllowed();

      await gameRepository.setTakebackRequest(tx, gameId, userId);
      fx.out.push({ topic: topics.gameUser(gameId, opponentId), message: { type: "takeback_request" } });
    });
  }

  async respondToTakeback(gameId: number, userId: number, accepted: boolean): Promise<void> {
    await this.run(gameId, async (tx, game, fx) => {
      if (game.status !== "in_progress") throw gameOver();
      if (!colorOf(game, userId)) throw notAPlayer();
      const now = Date.now();
      if (isPastDeadline(game, now)) {
        await this.endAtDeadline(tx, game, now, fx);
        return;
      }
      const requesterId = opponentOf(game, userId);
      // Only the opponent of whoever asked can answer
      if (game.takebackRequestedBy !== requesterId) {
        throw new AppError("There is no takeback request to answer", "NO_TAKEBACK_REQUEST", 409);
      }

      if (accepted) {
        await this.takeBack(tx, game, requesterId, now, fx);
      } else {
        await gameRepository.declineTakeback(tx, gameId, requesterId);
        fx.out.push({
          topic: topics.gameUser(gameId, requesterId),
          message: { type: "takeback_response", accepted: false },
        });
      }
    });
  }

  /**
   * Takes back `requesterId`'s last move, and the opponent's reply if there
   * is one, once both players agree. The side to move is charged their time
   * up to now and both clocks keep what they have left (time spent on the
   * undone moves isn't given back); the clock then runs for whoever is to
   * move in the restored position. Clears a pending draw offer.
   */
  private async takeBack(tx: TxClient, game: LiveGame, requesterId: number, now: number, fx: TxEffects) {
    const state = clockOf(game);
    // A flag that has fallen (but is still within the lag allowance) decides
    // the game, not a takeback
    if (isFlagged(state, now)) {
      await this.endAtDeadline(tx, game, now, fx);
      return;
    }
    // Checked again: the request was valid when made, but is now applied to
    // whatever position the game is in
    const plies = takebackPlies(game.numMoves, colorOf(game, requesterId)!);
    if (plies === null) throw takebackNotAllowed();

    const chess = this.position(game);
    const position = undoMoves(chess, game.numMoves, plies, game.pgn ?? "");
    const at = Math.max(now, state.lastMoveAt);
    const clock: ClockState = { ...remainingAt(state, at), lastMoveAt: at, ply: position.ply };
    const deadlineAt = new Date(deadline(clock));
    // Nothing follows: it goes out with COMMIT
    fx.finalStatement = saveMoveStatement(tx, game.id, {
      fen: position.fen,
      pgn: position.pgn,
      numMoves: position.ply,
      whiteTimeLeftMs: clock.whiteMs,
      blackTimeLeftMs: clock.blackMs,
      lastMoveAt: new Date(at),
      deadlineAt,
      drawOfferedBy: null,
      drawDeclinedFor: game.drawDeclinedFor,
      whiteLagBudgetMs: game.whiteLagBudgetMs,
      blackLagBudgetMs: game.blackLagBudgetMs,
    });
    fx.deadlines.push({ gameId: game.id, at: deadlineAt });
    fx.positions.push({ gameId: game.id, chess, pgn: position.pgn, ply: position.ply });
    fx.out.push({
      topic: topics.game(game.id),
      message: {
        type: "takeback",
        // The PGN too (unlike a move): the client drops moves it already has
        fen: position.fen,
        pgn: position.pgn,
        moveNumber: position.ply,
        clockRunning: isClockRunning(clock.ply),
        whiteTimeLeft: clock.whiteMs,
        blackTimeLeft: clock.blackMs,
      },
    });
  }

  /**
   * Ends the game if its deadline has passed: a flag fall, or a first move
   * that never came (abort). Called by the sweeper, on (re)connect, and when a
   * client reports that a clock hit zero. Safe to call any time.
   */
  async resolveDeadline(gameId: number): Promise<void> {
    // A plain read first: the row lock is only taken for a game that is due,
    // so connects and clock hints don't queue up behind moves
    const due = await gameRepository.findDeadline(this.fastify.pg, gameId);
    if (!due || due.status !== "in_progress" || !due.deadlineAt) return;
    // A paused game is decided only once even the longest resume would have
    // passed its deadline; run resumes it first
    const at = due.pausedAt
      ? new Date(pausedDeadline(due.deadlineAt.getTime(), due.pausedAt.getTime()))
      : due.deadlineAt;
    if (at.getTime() > Date.now()) {
      this.watchDeadline(gameId, at);
      return;
    }

    await this.run(gameId, async (tx, game, fx) => {
      if (game.status !== "in_progress" || !game.deadlineAt) return;
      const now = Date.now();
      if (game.deadlineAt.getTime() > now) {
        fx.deadlines.push({ gameId, at: game.deadlineAt });
        return;
      }

      await this.endAtDeadline(tx, game, now, fx);
    });
  }

  /** Ends a game whose deadline has passed: an abort, or a flag fall. */
  private async endAtDeadline(tx: TxClient, game: LiveGame, now: number, fx: TxEffects) {
    const state = clockOf(game);
    if (!isClockRunning(state.ply)) {
      // A tournament game isn't aborted: whoever didn't show up loses it
      // (unrated, see end) and is paused, so the opponent gets the points
      // and the absent player isn't paired again
      if (game.tournamentId !== null) {
        const absent = activeColor(state.ply);
        await this.end(
          tx,
          game,
          { result: winFor(absent === "white" ? "black" : "white"), reason: "timeout" },
          null,
          fx,
          absent === "white" ? game.whiteId : game.blackId
        );
        return;
      }
      await this.end(tx, game, { result: "aborted", reason: "aborted" }, null, fx);
      return;
    }
    const flagged = activeColor(state.ply);
    await this.end(tx, game, timeoutOutcome(this.position(game), flagged), remainingAt(state, now), fx);
  }

  /**
   * Adds GIVE_TIME_MS to the opponent's clock, moving their deadline if it's
   * their turn. Everyone on the game is told the new time left. A game whose
   * deadline has already passed ends instead: given time can't undo a flag
   * that has fallen.
   */
  async giveTime(gameId: number, userId: number): Promise<void> {
    await this.run(gameId, async (tx, game, fx) => {
      if (game.status !== "in_progress") throw gameOver();
      const color = colorOf(game, userId);
      if (!color) throw notAPlayer();
      if (game.tournamentId !== null) throw tournamentGame("Giving time");
      const now = Date.now();
      if (isPastDeadline(game, now)) {
        await this.endAtDeadline(tx, game, now, fx);
        return;
      }

      const receiver = color === "white" ? "black" : "white";
      const state = clockOf(game);
      const clock = addTime(state, receiver, GIVE_TIME_MS);
      const before = receiver === "white" ? state.whiteMs : state.blackMs;
      const after = receiver === "white" ? clock.whiteMs : clock.blackMs;
      if (after === before) return; // already at the most a clock can hold

      const deadlineAt = new Date(deadline(clock));
      await gameRepository.saveClock(tx, gameId, {
        whiteTimeLeftMs: clock.whiteMs,
        blackTimeLeftMs: clock.blackMs,
        deadlineAt,
      });
      fx.deadlines.push({ gameId, at: deadlineAt });

      const left = remainingAt(clock, now);
      fx.out.push({
        topic: topics.game(gameId),
        message: {
          type: "time_added",
          userId,
          color: receiver,
          addedMs: after - before,
          whiteTimeLeft: left.whiteMs,
          blackTimeLeft: left.blackMs,
        },
      });
    });
  }

  /**
   * A client's hint that a clock reached zero. Only the players' hints count;
   * anyone else watching is ignored, so spectators can't make the server do
   * work on the game.
   */
  async claimTimeout(gameId: number, userId: number): Promise<void> {
    const due = await gameRepository.findDeadline(this.fastify.pg, gameId);
    if (!due || (due.whiteId !== userId && due.blackId !== userId)) return;
    await this.resolveDeadline(gameId);
  }

  async requestRematch(gameId: number, userId: number): Promise<void> {
    await this.run(gameId, async (tx, game, fx) => {
      if (game.status !== "finished") throw new AppError("The game is still in progress", "GAME_IN_PROGRESS", 409);
      const color = colorOf(game, userId);
      if (!color) throw notAPlayer();
      if (game.tournamentId !== null) throw tournamentGame("A rematch");
      if (game.rematchGameId) return;
      const opponentId = opponentOf(game, userId);
      await assertNoBlock(tx, userId, opponentId);

      if (game.rematchRequestedBy === opponentId) {
        await this.startRematch(tx, game, fx);
        return;
      }
      if (game.rematchRequestedBy === userId) return;
      // One request per player and game: one that was declined or cancelled
      // can't be sent again
      if (color === "white" ? game.whiteRematchAsked : game.blackRematchAsked) throw rematchAlreadyRequested();

      await gameRepository.requestRematch(tx, gameId, userId, color);
      fx.out.push({ topic: topics.gameUser(gameId, opponentId), message: { type: "rematch_request", data: {} } });
    });
  }

  async respondToRematch(gameId: number, userId: number, accepted: boolean): Promise<void> {
    await this.run(gameId, async (tx, game, fx) => {
      if (!colorOf(game, userId)) throw notAPlayer();
      const requesterId = opponentOf(game, userId);
      if (game.rematchRequestedBy !== requesterId || game.rematchGameId) {
        throw new AppError("There is no rematch offer to answer", "NO_REMATCH_OFFER", 409);
      }

      if (accepted) {
        await assertNoBlock(tx, userId, requesterId);
        await this.startRematch(tx, game, fx);
      } else {
        await gameRepository.setRematchRequest(tx, gameId, null);
        fx.out.push({
          topic: topics.gameUser(gameId, requesterId),
          message: { type: "rematch_response", accepted: false },
        });
      }
    });
  }

  async cancelRematch(gameId: number, userId: number): Promise<void> {
    await this.run(gameId, async (tx, game, fx) => {
      if (!colorOf(game, userId) || game.rematchRequestedBy !== userId) return;
      await gameRepository.setRematchRequest(tx, gameId, null);
      fx.out.push({
        topic: topics.gameUser(gameId, opponentOf(game, userId)),
        message: { type: "rematch_canceled", data: { reason: "opponent_canceled" } },
      });
    });
  }

  private async startRematch(tx: TxClient, game: LiveGame, fx: TxEffects) {
    // Queue rows are locked before the players' rows (createGame), the order
    // matchmaking takes them in, so a player re-queueing while the rematch is
    // accepted can't deadlock the two
    await tx.query(`DELETE FROM matchmaking WHERE "userId" = ANY($1)`, [[game.whiteId, game.blackId]]);
    // In a series the next game follows the series' colours; otherwise
    // (and after a series is over) colours swap
    const next = await nextSeriesGame(tx, game);
    const whiteId = next ? next.whiteId : game.blackId;
    // Time odds belong to the players, not the colours: each keeps their clock
    const timeOf = (playerId: number) => (playerId === game.whiteId ? game.whiteTime : game.blackTime);
    const whiteTime = timeOf(whiteId);
    const blackTime = timeOf(whiteId === game.whiteId ? game.blackId : game.whiteId);
    const rematch = await createGame(tx, {
      whiteId,
      blackId: next ? next.blackId : game.whiteId,
      time: game.time,
      increment: game.increment,
      odds: whiteTime !== null && blackTime !== null ? { whiteTime, blackTime } : null,
      ...(next && { series: { id: next.seriesId, game: next.number } }),
    });
    await gameRepository.setRematchGame(tx, game.id, rematch.id);
    fx.deadlines.push({ gameId: rematch.id, at: rematch.deadlineAt });
    for (const playerId of [game.whiteId, game.blackId]) {
      fx.out.push({
        topic: topics.gameUser(game.id, playerId),
        message: { type: "match_found", data: matchFoundData(rematch, playerId) },
      });
      fx.out.push({ topic: topics.notifications(playerId), message: activeGameMessage(rematch.id) });
    }
  }
}

/** A rematch is off once either player has blocked the other (worded for both sides). */
async function assertNoBlock(tx: TxClient, userId: number, opponentId: number): Promise<void> {
  const blocks = await blocksBetween(tx, userId, opponentId);
  if (blocks.byFirst || blocks.bySecond) {
    throw new AppError("A rematch with this player isn't available", "REMATCH_UNAVAILABLE", 403);
  }
}

function isPastDeadline(game: LiveGame, now: number): boolean {
  return game.status === "in_progress" && game.deadlineAt !== null && game.deadlineAt.getTime() <= now;
}

function gameEndedMessage(
  outcome: Outcome,
  finished: { winnerId: number | null; ratingChanges: RatingChanges | null },
  series: SeriesSummary | null,
  tournament: TournamentGameResult | null = null
) {
  return {
    type: "game_ended",
    winnerId: finished.winnerId,
    result: outcome.result,
    reason: outcome.reason,
    ...(finished.ratingChanges && { ratingChanges: finished.ratingChanges }),
    // The series score after this game
    ...(series && { series }),
    // What the game scored in its tournament
    ...(tournament && { tournament }),
  };
}
