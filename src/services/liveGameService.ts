import type { FastifyInstance } from "fastify";
import type { Chess } from "chess.js";
import type { TxClient } from "../db.js";
import { isLiveGame, type LiveGame, type RatingChanges } from "../models/Game.js";
import { gameRepository } from "../repositories/gameRepository.js";
import {
  applyMoveTo,
  timeoutOutcome,
  type MoveInput,
  type Outcome,
  winFor,
} from "../game/engine.js";
import {
  activeColor,
  afterMove,
  deadline,
  isClockRunning,
  isFlagged,
  remainingAt,
  type ClockState,
} from "../game/clock.js";
import { STARTING_FEN } from "../game/engine.js";
import { colorOf, createGame, finishGame, matchFoundData, opponentOf } from "./gameService.js";
import { AppError } from "../errors/AppError.js";
import { activeGameMessage, topics, type RealtimeHub } from "../realtime/hub.js";
import { statsCacheKey } from "./statsService.js";
import { PositionCache } from "../game/positionCache.js";

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
}

/** Fires a moment after the deadline, so the clock has surely run out. */
const DEADLINE_SLACK_MS = 20;

function clockOf(game: LiveGame): ClockState {
  return {
    whiteMs: game.whiteTimeLeftMs ?? game.time * 1000,
    blackMs: game.blackTimeLeftMs ?? game.time * 1000,
    lastMoveAt: (game.lastMoveAt ?? game.createdAt).getTime(),
    ply: game.numMoves,
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

  private async run(gameId: number, fn: (tx: TxClient, game: LiveGame, fx: TxEffects) => Promise<void>) {
    const fx: TxEffects = { out: [], staleStats: [], ended: [], deadlines: [] };
    if (!Number.isSafeInteger(gameId) || gameId <= 0) throw notFound();
    const tx = await this.fastify.pg.connect();
    let broken = false;
    try {
      const game = await gameRepository.beginAndLock(tx, gameId);
      if (!game) throw notFound();
      if (!isLiveGame(game)) throw botGame();
      await fn(tx, game, fx);
      await tx.query("COMMIT");
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
    }
    for (const { gameId: id, at } of fx.deadlines) this.watchDeadline(id, at);
    // Before publishing: players refetch their stats as soon as they hear
    // the game ended
    if (fx.staleStats.length > 0) {
      await this.fastify.redis
        .del(fx.staleStats.map(statsCacheKey))
        .catch((err) => this.fastify.log.error({ err }, "Failed to clear stats cache"));
    }
    for (const { topic, message } of fx.out) {
      await this.hub
        .publish(topic, message)
        .catch((err) => this.fastify.log.error({ err, topic }, "Failed to publish game update"));
    }
  }

  /**
   * Turns on per-game deadline timers (off in tests, which drive the clock
   * by hand). Each live game gets a timer for the moment its clock runs out
   * or its first-move window closes, so the database isn't polled to find
   * them. Arms timers for the games already in progress.
   */
  async startDeadlineTimers(): Promise<void> {
    this.deadlineTimersEnabled = true;
    for (const { id, deadlineAt } of await gameRepository.findLiveDeadlines(this.fastify.pg)) {
      this.watchDeadline(id, deadlineAt);
    }
  }

  stopDeadlineTimers(): void {
    this.deadlineTimersEnabled = false;
    for (const id of [...this.deadlineTimers.keys()]) this.clearDeadline(id);
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
    this.clearDeadline(gameId);
    const timer = setTimeout(
      () => {
        this.deadlineTimers.delete(gameId);
        this.resolveDeadline(gameId).catch((err) =>
          this.fastify.log.error({ err, gameId }, "Resolving a game deadline failed")
        );
      },
      Math.max(0, when - Date.now()) + DEADLINE_SLACK_MS
    );
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
   * Full state for a (re)connecting client. Resolves an expired clock first.
   * Pending draw and rematch offers are between the players, so spectators
   * don't see them.
   */
  async getState(gameId: number, viewerId: number) {
    let game = await gameRepository.findById(this.fastify.pg, gameId);
    if (!game) throw notFound();
    // Bot games aren't opened as live games
    if (!isLiveGame(game)) throw botGame();
    // Only a game whose deadline has passed needs the locking transaction
    if (isPastDeadline(game, Date.now())) {
      await this.resolveDeadline(gameId);
      game = await gameRepository.findById(this.fastify.pg, gameId);
      if (!game || !isLiveGame(game)) throw notFound();
    }
    const isPlayer = colorOf(game, viewerId) !== null;
    const clock = game.status === "in_progress" ? remainingAt(clockOf(game), Date.now()) : null;
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
          avatarUrl: game.whiteAvatarUrl,
        },
        blackPlayer: {
          id: game.blackId,
          username: game.blackUsername,
          rating: game.blackRating,
          avatarUrl: game.blackAvatarUrl,
        },
        time: game.time,
        increment: game.increment,
        status: game.status,
        numMoves: game.numMoves,
        isFinished: game.status === "finished",
        clockRunning: isClockRunning(game.numMoves),
        whiteTimeLeft: clock?.whiteMs ?? game.whiteTimeLeftMs,
        blackTimeLeft: clock?.blackMs ?? game.blackTimeLeftMs,
        drawOfferedBy: isPlayer ? game.drawOfferedBy : null,
        rematchRequestedBy: isPlayer ? game.rematchRequestedBy : null,
        ...(game.status === "finished" && {
          result: game.result,
          reason: game.endReason,
          winnerId: game.winnerId,
          ratingChanges: {
            whiteRatingChange: game.whiteRatingChange ?? 0,
            blackRatingChange: game.blackRatingChange ?? 0,
            whiteNewRating: game.whiteRating + (game.whiteRatingChange ?? 0),
            blackNewRating: game.blackRating + (game.blackRatingChange ?? 0),
          },
        }),
      },
    };
  }

  /** Distinct users watching the game (players aren't counted). */
  async spectatorCount(gameId: number): Promise<number> {
    return this.hub.countMembers(spectatorsKey(gameId));
  }

  /** Tells everyone on the game how many people are watching. Never throws. */
  async publishSpectatorCount(gameId: number): Promise<void> {
    try {
      const count = await this.spectatorCount(gameId);
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
    fx: TxEffects
  ) {
    const finished = await finishGame(tx, game, outcome, clock);
    if (!finished) return;
    fx.staleStats.push(game.whiteId, game.blackId);
    fx.ended.push(game.id);
    fx.out.push({ topic: topics.game(game.id), message: gameEndedMessage(outcome, finished) });
    for (const playerId of [game.whiteId, game.blackId]) {
      fx.out.push({ topic: topics.notifications(playerId), message: activeGameMessage(null) });
    }
  }

  /** The current position, from the cache when it matches the locked row. */
  private position(game: LiveGame) {
    return this.positions.checkout(game.id, game.pgn, game.numMoves);
  }

  async move(gameId: number, userId: number, input: MoveInput): Promise<void> {
    let rejected: { reason: string; fen: string; pgn: string } | null = null;
    // The position after the stored move, cached once the transaction commits
    let played: { chess: Chess; pgn: string; ply: number } | null = null;

    await this.run(gameId, async (tx, game, fx) => {
      if (game.status !== "in_progress") throw gameOver();
      const color = colorOf(game, userId);
      if (!color) throw notAPlayer();

      const state = clockOf(game);
      const now = Date.now();
      if (activeColor(state.ply) !== color) {
        rejected = { reason: "Not your turn", fen: game.fen ?? "", pgn: game.pgn ?? "" };
        return;
      }
      // A move that arrives after the deadline doesn't count
      if (!isClockRunning(state.ply) && game.deadlineAt && game.deadlineAt.getTime() <= now) {
        await this.end(tx, game, { result: "aborted", reason: "aborted" }, null, fx);
        return;
      }
      const chess = this.position(game);
      if (isFlagged(state, now)) {
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

      const clock = afterMove(state, now, game.increment * 1000);
      // Moving declines the opponent's pending draw offer
      const drawOfferedBy = game.drawOfferedBy === userId ? userId : null;
      const deadlineAt = new Date(deadline(clock));
      await gameRepository.saveMove(tx, gameId, {
        fen: result.fen,
        pgn: result.pgn,
        numMoves: result.ply,
        whiteTimeLeftMs: clock.whiteMs,
        blackTimeLeftMs: clock.blackMs,
        lastMoveAt: new Date(clock.lastMoveAt),
        deadlineAt,
        drawOfferedBy,
      });
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

  async resign(gameId: number, userId: number): Promise<void> {
    await this.run(gameId, async (tx, game, fx) => {
      if (game.status !== "in_progress") throw gameOver();
      const color = colorOf(game, userId);
      if (!color) throw notAPlayer();
      const winner = color === "white" ? "black" : "white";
      const clock = remainingAt(clockOf(game), Date.now());
      await this.end(tx, game, { result: winFor(winner), reason: "resignation" }, clock, fx);
    });
  }

  /** Allowed until both players have made their first move. */
  async abort(gameId: number, userId: number): Promise<void> {
    await this.run(gameId, async (tx, game, fx) => {
      if (game.status !== "in_progress") throw gameOver();
      if (!colorOf(game, userId)) throw notAPlayer();
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

      // Both players offering means both agree
      if (game.drawOfferedBy === opponentId) {
        const clock = remainingAt(clockOf(game), Date.now());
        await this.end(tx, game, { result: "draw", reason: "draw_agreement" }, clock, fx);
        return;
      }
      if (game.drawOfferedBy === userId) return;

      await gameRepository.setDrawOffer(tx, gameId, userId);
      fx.out.push({ topic: topics.gameUser(gameId, opponentId), message: { type: "draw_offer" } });
    });
  }

  async respondToDraw(gameId: number, userId: number, accepted: boolean): Promise<void> {
    await this.run(gameId, async (tx, game, fx) => {
      if (game.status !== "in_progress") throw gameOver();
      if (!colorOf(game, userId)) throw notAPlayer();
      const offererId = opponentOf(game, userId);
      // Only the opponent of whoever offered can answer
      if (game.drawOfferedBy !== offererId) {
        throw new AppError("There is no draw offer to answer", "NO_DRAW_OFFER", 409);
      }

      if (accepted) {
        const clock = remainingAt(clockOf(game), Date.now());
        await this.end(tx, game, { result: "draw", reason: "draw_agreement" }, clock, fx);
      } else {
        await gameRepository.setDrawOffer(tx, gameId, null);
        fx.out.push({
          topic: topics.gameUser(gameId, offererId),
          message: { type: "draw_response", accepted: false, userId },
        });
      }
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
    if (due.deadlineAt.getTime() > Date.now()) {
      this.watchDeadline(gameId, due.deadlineAt);
      return;
    }

    await this.run(gameId, async (tx, game, fx) => {
      if (game.status !== "in_progress" || !game.deadlineAt) return;
      const now = Date.now();
      if (game.deadlineAt.getTime() > now) {
        fx.deadlines.push({ gameId, at: game.deadlineAt });
        return;
      }

      const state = clockOf(game);
      if (!isClockRunning(state.ply)) {
        await this.end(tx, game, { result: "aborted", reason: "aborted" }, null, fx);
        return;
      }
      const flagged = activeColor(state.ply);
      await this.end(tx, game, timeoutOutcome(this.position(game), flagged), remainingAt(state, now), fx);
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
      if (!colorOf(game, userId)) throw notAPlayer();
      if (game.rematchGameId) return;
      const opponentId = opponentOf(game, userId);

      if (game.rematchRequestedBy === opponentId) {
        await this.startRematch(tx, game, fx);
        return;
      }
      if (game.rematchRequestedBy === userId) return;

      await gameRepository.setRematchRequest(tx, gameId, userId);
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
    // Colors swap
    const rematch = await createGame(tx, {
      whiteId: game.blackId,
      blackId: game.whiteId,
      time: game.time,
      increment: game.increment,
    });
    await gameRepository.setRematchGame(tx, game.id, rematch.id);
    fx.deadlines.push({ gameId: rematch.id, at: rematch.deadlineAt });
    await tx.query(`DELETE FROM matchmaking WHERE "userId" = ANY($1)`, [[game.whiteId, game.blackId]]);
    for (const playerId of [game.whiteId, game.blackId]) {
      fx.out.push({
        topic: topics.gameUser(game.id, playerId),
        message: { type: "match_found", data: matchFoundData(rematch, playerId) },
      });
      fx.out.push({ topic: topics.notifications(playerId), message: activeGameMessage(rematch.id) });
    }
  }
}

function isPastDeadline(game: LiveGame, now: number): boolean {
  return game.status === "in_progress" && game.deadlineAt !== null && game.deadlineAt.getTime() <= now;
}

function gameEndedMessage(
  outcome: Outcome,
  finished: { winnerId: number | null; ratingChanges: RatingChanges | null }
) {
  return {
    type: "game_ended",
    winnerId: finished.winnerId,
    result: outcome.result,
    reason: outcome.reason,
    ...(finished.ratingChanges && { ratingChanges: finished.ratingChanges }),
  };
}
