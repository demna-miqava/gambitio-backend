import type { FastifyInstance } from "fastify";
import type { TxClient } from "../db.js";
import { isLiveGame, type LiveGame, type RatingChanges } from "../models/Game.js";
import { gameRepository } from "../repositories/gameRepository.js";
import {
  applyMove,
  loadGame,
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
import { colorOf, createGame, finishGame, matchFoundData, opponentOf } from "./gameService.js";
import { AppError } from "../errors/AppError.js";
import { topics, type RealtimeHub } from "../realtime/hub.js";
import { statsCacheKey } from "./statsService.js";

interface Outgoing {
  topic: string;
  message: object;
}

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

  // Per transaction: players whose cached stats to drop after it commits
  private staleStats = new WeakMap<Outgoing[], number[]>();

  private async run(gameId: number, fn: (tx: TxClient, game: LiveGame, out: Outgoing[]) => Promise<void>) {
    const out: Outgoing[] = [];
    await this.fastify.pg.transact(async (tx) => {
      const game = await gameRepository.lockById(tx, gameId);
      if (!game) throw notFound();
      if (!isLiveGame(game)) throw botGame();
      await fn(tx, game, out);
    });
    // The transaction has committed: from here on nothing may throw, or the
    // client gets an error for an action that actually happened.
    for (const { topic, message } of out) {
      await this.hub
        .publish(topic, message)
        .catch((err) => this.fastify.log.error({ err, topic }, "Failed to publish game update"));
    }
    const stale = this.staleStats.get(out);
    if (stale) {
      await this.fastify.redis
        .del(stale.map(statsCacheKey))
        .catch((err) => this.fastify.log.error({ err }, "Failed to clear stats cache"));
    }
  }

  /**
   * Full state for a (re)connecting client. Resolves an expired clock first.
   * Pending draw and rematch offers are between the players, so spectators
   * don't see them.
   */
  async getState(gameId: number, viewerId: number) {
    // Throws for bot games, so they aren't opened as live games
    await this.resolveDeadline(gameId);
    const game = await gameRepository.findById(this.fastify.pg, gameId);
    if (!game) throw notFound();
    if (!isLiveGame(game)) throw botGame();
    const isPlayer = colorOf(game, viewerId) !== null;
    const clock = game.status === "in_progress" ? remainingAt(clockOf(game), Date.now()) : null;
    return {
      type: "initial_game_state",
      data: {
        gameId: game.id,
        fen: game.fen ?? loadGame(null).fen(),
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
    out: Outgoing[]
  ) {
    const finished = await finishGame(tx, game, outcome, clock);
    if (!finished) return;
    this.staleStats.set(out, [...(this.staleStats.get(out) ?? []), game.whiteId, game.blackId]);
    out.push({ topic: topics.game(game.id), message: gameEndedMessage(outcome, finished) });
  }

  async move(gameId: number, userId: number, input: MoveInput): Promise<void> {
    let rejected: { reason: string; fen: string; pgn: string } | null = null;

    await this.run(gameId, async (tx, game, out) => {
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
        await this.end(tx, game, { result: "aborted", reason: "aborted" }, null, out);
        return;
      }
      if (isFlagged(state, now)) {
        await this.end(tx, game, timeoutOutcome(loadGame(game.pgn), color), remainingAt(state, now), out);
        return;
      }

      const result = applyMove(game.pgn, input);
      if (!result.ok) {
        rejected = { reason: result.reason, fen: game.fen ?? "", pgn: game.pgn ?? "" };
        return;
      }

      const clock = afterMove(state, now, game.increment * 1000);
      // Moving declines the opponent's pending draw offer
      const drawOfferedBy = game.drawOfferedBy === userId ? userId : null;
      await gameRepository.saveMove(tx, gameId, {
        fen: result.fen,
        pgn: result.pgn,
        numMoves: result.ply,
        whiteTimeLeftMs: clock.whiteMs,
        blackTimeLeftMs: clock.blackMs,
        lastMoveAt: new Date(clock.lastMoveAt),
        deadlineAt: new Date(deadline(clock)),
        drawOfferedBy,
      });

      out.push({
        topic: topics.game(gameId),
        message: {
          type: "move",
          move: result.move,
          fen: result.fen,
          pgn: result.pgn,
          userId,
          moveNumber: result.ply,
          clockRunning: isClockRunning(clock.ply),
          whiteTimeLeft: clock.whiteMs,
          blackTimeLeft: clock.blackMs,
        },
      });

      if (result.outcome) {
        const updated = { ...game, numMoves: result.ply, drawOfferedBy };
        await this.end(tx, updated, result.outcome, clock, out);
      }
    });

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
    await this.run(gameId, async (tx, game, out) => {
      if (game.status !== "in_progress") throw gameOver();
      const color = colorOf(game, userId);
      if (!color) throw notAPlayer();
      const winner = color === "white" ? "black" : "white";
      const clock = remainingAt(clockOf(game), Date.now());
      await this.end(tx, game, { result: winFor(winner), reason: "resignation" }, clock, out);
    });
  }

  /** Allowed until both players have made their first move. */
  async abort(gameId: number, userId: number): Promise<void> {
    await this.run(gameId, async (tx, game, out) => {
      if (game.status !== "in_progress") throw gameOver();
      if (!colorOf(game, userId)) throw notAPlayer();
      if (game.numMoves >= 2) {
        throw new AppError("The game can no longer be aborted", "ABORT_NOT_ALLOWED", 409);
      }
      await this.end(tx, game, { result: "aborted", reason: "aborted" }, null, out);
    });
  }

  async offerDraw(gameId: number, userId: number): Promise<void> {
    await this.run(gameId, async (tx, game, out) => {
      if (game.status !== "in_progress") throw gameOver();
      if (!colorOf(game, userId)) throw notAPlayer();
      const opponentId = opponentOf(game, userId);

      // Both players offering means both agree
      if (game.drawOfferedBy === opponentId) {
        const clock = remainingAt(clockOf(game), Date.now());
        await this.end(tx, game, { result: "draw", reason: "draw_agreement" }, clock, out);
        return;
      }
      if (game.drawOfferedBy === userId) return;

      await gameRepository.setDrawOffer(tx, gameId, userId);
      out.push({ topic: topics.gameUser(gameId, opponentId), message: { type: "draw_offer" } });
    });
  }

  async respondToDraw(gameId: number, userId: number, accepted: boolean): Promise<void> {
    await this.run(gameId, async (tx, game, out) => {
      if (game.status !== "in_progress") throw gameOver();
      if (!colorOf(game, userId)) throw notAPlayer();
      const offererId = opponentOf(game, userId);
      // Only the opponent of whoever offered can answer
      if (game.drawOfferedBy !== offererId) {
        throw new AppError("There is no draw offer to answer", "NO_DRAW_OFFER", 409);
      }

      if (accepted) {
        const clock = remainingAt(clockOf(game), Date.now());
        await this.end(tx, game, { result: "draw", reason: "draw_agreement" }, clock, out);
      } else {
        await gameRepository.setDrawOffer(tx, gameId, null);
        out.push({
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
    await this.run(gameId, async (tx, game, out) => {
      if (game.status !== "in_progress" || !game.deadlineAt) return;
      const now = Date.now();
      if (game.deadlineAt.getTime() > now) return;

      const state = clockOf(game);
      if (!isClockRunning(state.ply)) {
        await this.end(tx, game, { result: "aborted", reason: "aborted" }, null, out);
        return;
      }
      const flagged = activeColor(state.ply);
      await this.end(tx, game, timeoutOutcome(loadGame(game.pgn), flagged), remainingAt(state, now), out);
    });
  }

  async requestRematch(gameId: number, userId: number): Promise<void> {
    await this.run(gameId, async (tx, game, out) => {
      if (game.status !== "finished") throw new AppError("The game is still in progress", "GAME_IN_PROGRESS", 409);
      if (!colorOf(game, userId)) throw notAPlayer();
      if (game.rematchGameId) return;
      const opponentId = opponentOf(game, userId);

      if (game.rematchRequestedBy === opponentId) {
        await this.startRematch(tx, game, out);
        return;
      }
      if (game.rematchRequestedBy === userId) return;

      await gameRepository.setRematchRequest(tx, gameId, userId);
      out.push({ topic: topics.gameUser(gameId, opponentId), message: { type: "rematch_request", data: {} } });
    });
  }

  async respondToRematch(gameId: number, userId: number, accepted: boolean): Promise<void> {
    await this.run(gameId, async (tx, game, out) => {
      if (!colorOf(game, userId)) throw notAPlayer();
      const requesterId = opponentOf(game, userId);
      if (game.rematchRequestedBy !== requesterId || game.rematchGameId) {
        throw new AppError("There is no rematch offer to answer", "NO_REMATCH_OFFER", 409);
      }

      if (accepted) {
        await this.startRematch(tx, game, out);
      } else {
        await gameRepository.setRematchRequest(tx, gameId, null);
        out.push({
          topic: topics.gameUser(gameId, requesterId),
          message: { type: "rematch_response", accepted: false },
        });
      }
    });
  }

  async cancelRematch(gameId: number, userId: number): Promise<void> {
    await this.run(gameId, async (tx, game, out) => {
      if (!colorOf(game, userId) || game.rematchRequestedBy !== userId) return;
      await gameRepository.setRematchRequest(tx, gameId, null);
      out.push({
        topic: topics.gameUser(gameId, opponentOf(game, userId)),
        message: { type: "rematch_canceled", data: { reason: "opponent_canceled" } },
      });
    });
  }

  private async startRematch(tx: TxClient, game: LiveGame, out: Outgoing[]) {
    // Colors swap
    const rematch = await createGame(tx, {
      whiteId: game.blackId,
      blackId: game.whiteId,
      time: game.time,
      increment: game.increment,
    });
    await gameRepository.setRematchGame(tx, game.id, rematch.id);
    await tx.query(`DELETE FROM matchmaking WHERE "userId" = ANY($1)`, [[game.whiteId, game.blackId]]);
    for (const playerId of [game.whiteId, game.blackId]) {
      out.push({
        topic: topics.gameUser(game.id, playerId),
        message: { type: "match_found", data: matchFoundData(rematch, playerId) },
      });
    }
  }
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
