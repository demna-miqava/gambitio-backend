import type { TxClient } from "../db.js";
import type { LiveGame } from "../models/Game.js";
import { gameRepository } from "../repositories/gameRepository.js";
import { blocksBetween } from "../repositories/blockRepository.js";
import { AppError } from "../errors/AppError.js";
import { topics, type RealtimeHub } from "../realtime/hub.js";
import {
  colorOf,
  createGame,
  dequeuePlayers,
  dropChallengesOf,
  linkNextGame,
  notAPlayer,
  opponentOf,
  tournamentGame,
} from "./gameService.js";
import { inActiveTimedMatch, nextSeriesGame, timedMatchError } from "./seriesService.js";
import type { GameTransaction, TxEffects } from "./liveGameService.js";

const rematchAlreadyRequested = () =>
  new AppError("You can only ask for a rematch once per game", "REMATCH_ALREADY_REQUESTED", 409);

/**
 * Rematches of a finished game: offering one, answering or withdrawing the
 * offer, and starting the new game once both want it. Each action runs in
 * the finished game's own transaction (LiveGameService's runner, `run`), so
 * it is serialized with everything else done to that game, and its messages,
 * the new game's deadline and the challenges it drops go out through the
 * runner's effects once it commits. Reached through fastify.liveGames.
 */
export class RematchService {
  constructor(
    private hub: RealtimeHub,
    private run: GameTransaction
  ) {}

  async requestRematch(gameId: number, userId: number): Promise<void> {
    await this.run(gameId, async (tx, game, fx) => {
      if (game.status !== "finished") throw new AppError("The game is still in progress", "GAME_IN_PROGRESS", 409);
      const color = colorOf(game, userId);
      if (!color) throw notAPlayer();
      if (game.tournamentId !== null) throw tournamentGame("A rematch");
      if (game.rematchGameId) return;
      if (await inActiveTimedMatch(tx, game)) throw timedMatchError();
      const opponentId = opponentOf(game, userId);
      await assertNoBlock(tx, userId, opponentId);
      await assertLatestInSeries(tx, game);

      if (game.rematchRequestedBy === opponentId) {
        if (await this.rematchOfferStands(game, opponentId)) {
          await this.startRematch(tx, game, fx);
          return;
        }
        // The opponent has left: their offer goes, and this one is sent as
        // any other (overwriting it)
        await this.withdrawRematch(tx, game, userId, fx);
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
        await assertLatestInSeries(tx, game);
        if (await this.rematchOfferStands(game, requesterId)) await this.startRematch(tx, game, fx);
        else await this.withdrawRematch(tx, game, userId, fx);
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

  /**
   * Whether a rematch offer still stands: its sender is still on the game.
   * An offer has no expiry of its own, so without this one accepted long
   * after its sender left would pull them into a game they no longer
   * expect (and out of the matchmaking queue). A game's sockets all go to
   * one instance (worker/index.ts), which is this one, as the accepting
   * player's socket is here; only while another instance runs too (a
   * deploy switching over) may the sender's socket be on it, and then being
   * on the site at all counts.
   */
  private async rematchOfferStands(game: LiveGame, requesterId: number): Promise<boolean> {
    if (this.hub.localCount(topics.gameUser(game.id, requesterId)) > 0) return true;
    if (!this.hub.othersAlive) return false;
    return this.hub.isPresent("notifications", requesterId).catch(() => false);
  }

  /** Drops a rematch offer whose sender has left (see rematchOfferStands), telling `userId`, who answered it. */
  private async withdrawRematch(tx: TxClient, game: LiveGame, userId: number, fx: TxEffects) {
    await gameRepository.setRematchRequest(tx, game.id, null);
    fx.out.push({
      topic: topics.gameUser(game.id, userId),
      message: { type: "rematch_canceled", data: { reason: "opponent_left" } },
    });
  }

  private async startRematch(tx: TxClient, game: LiveGame, fx: TxEffects) {
    // Queue rows first, then the series and the players' rows (createGame):
    // the order every game start takes (see dequeuePlayers), so a player
    // re-queueing while the rematch is accepted can't deadlock the two
    await dequeuePlayers(tx, [game.whiteId, game.blackId]);
    // In a series the next game follows the series' colours; otherwise
    // (and after a series is over) colours swap
    const series = await nextSeriesGame(tx, game);
    const next = series?.next ?? null;
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
      // A casual game's rematch is casual too, as is every game of a casual
      // series. A series game takes the series' setting, not its own: one
      // made unrated only because a player never moved (a timed match) says
      // nothing of the next. (Tournament games have no rematch.)
      rated: series ? series.rated : game.rated,
      // From the same opening (in a series, the series' opening is the game's)
      openingId: game.openingId,
      ...(next && { series: { id: next.seriesId, game: next.number } }),
    });
    // The two are playing now, so their open challenges go
    fx.droppedChallenges.push(...(await dropChallengesOf(tx, [game.whiteId, game.blackId])));
    fx.startedPlayers.push(game.whiteId, game.blackId);
    fx.deadlines.push({ gameId: rematch.id, at: rematch.deadlineAt });
    fx.out.push(...(await linkNextGame(tx, game.id, rematch)));
  }
}

/** A rematch is off once either player has blocked the other (worded for both sides). */
async function assertNoBlock(tx: TxClient, userId: number, opponentId: number): Promise<void> {
  const blocks = await blocksBetween(tx, userId, opponentId);
  if (blocks.byFirst || blocks.bySecond) {
    throw new AppError("A rematch with this player isn't available", "REMATCH_UNAVAILABLE", 403);
  }
}

/**
 * Only the latest game of a series can be rematched (its rematch is the
 * series' next game): an older one's offer would start a game the series
 * has moved past, or once it is over a game outside it. A series goes on
 * from its latest game, or from a challenge (ChallengeService), which
 * leaves the game before it without a rematch.
 */
async function assertLatestInSeries(tx: TxClient, game: LiveGame): Promise<void> {
  if (game.seriesId === null) return;
  const { rows } = await tx.query(`SELECT 1 FROM games WHERE "seriesId" = $1 AND id > $2 LIMIT 1`, [
    game.seriesId,
    game.id,
  ]);
  if (rows.length > 0) {
    throw new AppError("The series has moved on to a later game", "REMATCH_UNAVAILABLE", 409);
  }
}
