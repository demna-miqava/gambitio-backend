import type { FastifyInstance } from "fastify";
import { AppError } from "../errors/AppError.js";
import { gameRepository } from "../repositories/gameRepository.js";
import { AlreadyInGameError, createGame, matchFoundData } from "./gameService.js";
import { activeGameMessage, topics, type RealtimeHub } from "../realtime/hub.js";
import { getTimeControl, ratingColumns, type PlayerColor } from "../models/common.js";
import { seriesColors } from "../game/series.js";
import { seriesRepository, type SeriesRow } from "./seriesService.js";

export interface Challenge {
  id: number;
  createdAt: Date;
  challengerId: number;
  challengedId: number;
  challengerUsername: string;
  challengedUsername: string | null;
  challengerAvatarUrl: string | null;
  challengedAvatarUrl: string | null;
  time: number;
  increment: number;
  challengerColor: PlayerColor;
  /** 1 for a single game; 3 or 5 for a series */
  bestOf: number;
  /** Set when accepting plays the next game of an existing series */
  seriesId: number | null;
}

/** A challenge with the number of the series game it would start (continuations only) */
export type ChallengeWithSeriesGame = Challenge & { seriesGame: number | null };

/** The series game a challenge starts: the next one of its series */
const SERIES_GAME_SELECT = `(SELECT s."gamesPlayed" + 1 FROM series s WHERE s.id = c."seriesId") AS "seriesGame"`;

/** Open challenges older than this are withdrawn by the challenge sweep */
export const CHALLENGE_TTL_MS = 10 * 60_000;

/**
 * How long a challenger may be offline (reloading, reconnecting) before their
 * challenges are withdrawn. Mutable so tests can shorten it.
 */
export const challengeTimings = { offlineGraceMs: 15_000 };

/** Why a challenge ended without being answered, as told to its sender */
type WithdrawReason = "expired" | "offline";

const unavailable = () =>
  new AppError("Player is currently unavailable", "OPPONENT_UNAVAILABLE", 409);

/**
 * Friend challenges. Accepting deletes the challenge row with RETURNING
 * inside the same transaction that creates the game, so a challenge can be
 * accepted at most once.
 */
export class ChallengeService {
  private graceTimers = new Map<number, NodeJS.Timeout>();

  constructor(
    private fastify: FastifyInstance,
    private hub: RealtimeHub
  ) {
    fastify.addHook("onClose", async () => {
      for (const timer of this.graceTimers.values()) clearTimeout(timer);
      this.graceTimers.clear();
    });
  }

  /** The challenge the user sent and is waiting on, if any (the latest one). */
  async getChallengeSentByUser(userId: number): Promise<ChallengeWithSeriesGame | null> {
    const { rows } = await this.fastify.pg.query<ChallengeWithSeriesGame>(
      `SELECT c.*, ${SERIES_GAME_SELECT} FROM challenges c WHERE c."challengerId" = $1 AND c."createdAt" > $2
       ORDER BY c."createdAt" DESC LIMIT 1`,
      [userId, new Date(Date.now() - CHALLENGE_TTL_MS)]
    );
    return rows[0] ?? null;
  }

  /**
   * Called when one of the user's notification sockets closes. If they are
   * still offline once the grace period is over, their challenges are
   * withdrawn (accepting would fail anyway, see accept()).
   */
  async withdrawIfStillOffline(userId: number): Promise<void> {
    if (await this.hub.isPresent("notifications", userId)) return;
    clearTimeout(this.graceTimers.get(userId));
    const timer = setTimeout(() => {
      this.graceTimers.delete(userId);
      if (this.hub.isStopping) return;
      void (async () => {
        if (await this.hub.isPresent("notifications", userId)) return;
        await this.withdrawAllFrom(userId, "offline");
      })().catch((err) => this.fastify.log.error({ err }, "Withdrawing challenges failed"));
    }, challengeTimings.offlineGraceMs);
    timer.unref();
    this.graceTimers.set(userId, timer);
  }

  /** With the challenger's current rating for each challenge's time control */
  async getChallengesReceivedByUser(
    userId: number
  ): Promise<(ChallengeWithSeriesGame & { challengerRating: number })[]> {
    const { rows } = await this.fastify.pg.query<
      ChallengeWithSeriesGame & { bulletRating: number; blitzRating: number; rapidRating: number }
    >(
      `SELECT c.*, ${SERIES_GAME_SELECT}, u."bulletRating", u."blitzRating", u."rapidRating"
       FROM challenges c JOIN users u ON u.id = c."challengerId"
       WHERE c."challengedId" = $1 AND c."createdAt" > $2
       ORDER BY c."createdAt" DESC`,
      [userId, new Date(Date.now() - CHALLENGE_TTL_MS)]
    );
    return rows.map(({ bulletRating, blitzRating, rapidRating, ...challenge }) => {
      const ratings = { bulletRating, blitzRating, rapidRating };
      return { ...challenge, challengerRating: ratings[ratingColumns(getTimeControl(challenge.time)).rating] };
    });
  }

  private async ratingOf(userId: number, time: number): Promise<number | undefined> {
    const column = ratingColumns(getTimeControl(time)).rating;
    const { rows } = await this.fastify.pg.query<{ rating: number }>(
      `SELECT "${column}" AS rating FROM users WHERE id = $1`,
      [userId]
    );
    return rows[0]?.rating;
  }

  private async isAvailable(userId: number): Promise<boolean> {
    if (!(await this.hub.isPresent("notifications", userId))) return false;
    return (await gameRepository.findActiveGameIdForUser(this.fastify.pg, userId)) === null;
  }

  async send(
    challenger: { id: number; username: string; avatarUrl: string | null },
    data: {
      challengedId: number;
      color: PlayerColor | "random";
      time: number;
      increment: number;
      bestOf?: number | undefined;
      /** Continue this series: its settings replace the ones sent */
      seriesId?: number | undefined;
    }
  ): Promise<void> {
    if (data.challengedId === challenger.id) {
      throw new AppError("You can't challenge yourself", "SELF_CHALLENGE", 400);
    }
    // The next game of a series: the opponent, time control, length and
    // colours are the series' own
    const series = data.seriesId !== undefined ? await this.continuation(data.seriesId, challenger.id) : null;
    if (series) {
      const opponentId = series.playerOneId === challenger.id ? series.playerTwoId : series.playerOneId;
      if (data.challengedId !== opponentId) {
        throw new AppError("That player isn't in this series", "NOT_IN_SERIES", 400);
      }
      const colors = seriesColors(series, series.gamesPlayed + 1);
      data = {
        ...data,
        time: series.time,
        increment: series.increment,
        bestOf: series.bestOf,
        color: colors.whiteId === challenger.id ? "white" : "black",
      };
    }
    const { rows: friendship } = await this.fastify.pg.query(
      `SELECT 1 FROM friends
       WHERE LEAST("userOneId", "userTwoId") = LEAST($1::int, $2::int)
         AND GREATEST("userOneId", "userTwoId") = GREATEST($1::int, $2::int)`,
      [challenger.id, data.challengedId]
    );
    if (friendship.length === 0) {
      throw new AppError("You can only challenge friends", "NOT_FRIENDS", 403);
    }
    const ownGameId = await gameRepository.findActiveGameIdForUser(this.fastify.pg, challenger.id);
    if (ownGameId !== null) throw new AlreadyInGameError(ownGameId);
    if (!(await this.isAvailable(data.challengedId))) throw unavailable();

    const challengerColor: PlayerColor =
      data.color === "random" ? (Math.random() < 0.5 ? "white" : "black") : data.color;

    const { rows } = await this.fastify.pg.query<Challenge>(
      `INSERT INTO challenges (
         "challengerId", "challengedId", "challengerUsername", "challengedUsername",
         "challengerAvatarUrl", "challengedAvatarUrl", time, increment, "challengerColor", "bestOf", "seriesId")
       SELECT $1, u.id, $2, u.username, $3, u."avatarUrl", $4, $5, $6, $8, $9
       FROM users u WHERE u.id = $7
       ON CONFLICT ("challengerId", "challengedId") DO UPDATE SET
         time = EXCLUDED.time, increment = EXCLUDED.increment,
         "challengerColor" = EXCLUDED."challengerColor", "bestOf" = EXCLUDED."bestOf",
         "seriesId" = EXCLUDED."seriesId", "createdAt" = now()
       RETURNING *`,
      [
        challenger.id,
        challenger.username,
        challenger.avatarUrl,
        data.time,
        data.increment,
        challengerColor,
        data.challengedId,
        data.bestOf ?? 1,
        series?.id ?? null,
      ]
    );
    // Sending again to the same player replaces the open challenge (new
    // settings, fresh expiry), so a client that lost track of it isn't stuck
    const challenge = rows[0];
    if (!challenge) throw new AppError("Challenged user not found", "USER_NOT_FOUND", 404);

    await this.hub.publish(topics.notifications(data.challengedId), {
      type: "challenge_received",
      data: {
        id: challenge.id,
        challengerId: challenger.id,
        username: challenger.username,
        avatarUrl: challenger.avatarUrl ?? "",
        rating: await this.ratingOf(challenger.id, challenge.time),
        time: challenge.time,
        increment: challenge.increment,
        // From the challenged player's point of view
        color: challengerColor === "white" ? "black" : "white",
        bestOf: challenge.bestOf,
        ...(series && { seriesId: series.id, seriesGame: series.gamesPlayed + 1 }),
        createdAt: new Date(challenge.createdAt).toISOString(),
      },
    });
  }

  /** The series a player wants to continue, if they may: theirs, active, between games. */
  private async continuation(seriesId: number, userId: number): Promise<SeriesRow> {
    const series = await seriesRepository.find(this.fastify.pg, seriesId);
    if (!series) throw new AppError("Series not found", "SERIES_NOT_FOUND", 404);
    if (series.playerOneId !== userId && series.playerTwoId !== userId) {
      throw new AppError("You are not playing in this series", "NOT_IN_SERIES", 403);
    }
    if (series.status !== "active") throw new AppError("The series is over", "SERIES_OVER", 409);
    if (await seriesRepository.hasGameInProgress(this.fastify.pg, seriesId)) {
      throw new AppError("A game of this series is being played", "SERIES_GAME_IN_PROGRESS", 409);
    }
    return series;
  }

  /** Withdraws the challenges that would continue a series that just ended. */
  async withdrawForSeries(seriesId: number): Promise<void> {
    const { rows } = await this.fastify.pg.query<{ challengerId: number; challengedId: number }>(
      `DELETE FROM challenges WHERE "seriesId" = $1 RETURNING "challengerId", "challengedId"`,
      [seriesId]
    );
    await this.notifyWithdrawn(rows, "expired");
  }

  async decline(challengedId: number, challengerId: number): Promise<void> {
    const { rowCount } = await this.fastify.pg.query(
      `DELETE FROM challenges WHERE "challengerId" = $1 AND "challengedId" = $2`,
      [challengerId, challengedId]
    );
    if (rowCount) {
      await this.hub.publish(topics.notifications(challengerId), {
        type: "challenge_declined",
        data: { challengedId },
      });
      // The decliner's other tabs drop the challenge too
      await this.hub.publish(topics.notifications(challengedId), {
        type: "challenge_cancelled",
        data: { challengerId, reason: "declined" },
      });
    }
  }

  /** The challenger withdraws a challenge they sent. */
  async cancel(challengerId: number, challengedId: number): Promise<void> {
    const { rowCount } = await this.fastify.pg.query(
      `DELETE FROM challenges WHERE "challengerId" = $1 AND "challengedId" = $2`,
      [challengerId, challengedId]
    );
    if (rowCount) {
      await this.hub.publish(topics.notifications(challengedId), {
        type: "challenge_cancelled",
        data: { challengerId },
      });
    }
  }

  /** Withdraws every challenge a user sent (they went offline). */
  async withdrawAllFrom(challengerId: number, reason: WithdrawReason): Promise<void> {
    const { rows } = await this.fastify.pg.query<{ challengerId: number; challengedId: number }>(
      `DELETE FROM challenges WHERE "challengerId" = $1 RETURNING "challengerId", "challengedId"`,
      [challengerId]
    );
    await this.notifyWithdrawn(rows, reason);
  }

  /** Withdraws challenges nobody answered within CHALLENGE_TTL_MS. */
  async expireStale(now = new Date()): Promise<void> {
    const { rows } = await this.fastify.pg.query<{ challengerId: number; challengedId: number }>(
      `DELETE FROM challenges WHERE "createdAt" <= $1 RETURNING "challengerId", "challengedId"`,
      [new Date(now.getTime() - CHALLENGE_TTL_MS)]
    );
    await this.notifyWithdrawn(rows, "expired");
  }

  private async notifyWithdrawn(
    rows: { challengerId: number; challengedId: number }[],
    reason: WithdrawReason
  ): Promise<void> {
    for (const { challengerId, challengedId } of rows) {
      await this.hub.publish(topics.notifications(challengedId), {
        type: "challenge_cancelled",
        data: { challengerId },
      });
      await this.hub.publish(topics.notifications(challengerId), {
        type: "challenge_declined",
        data: { challengedId, reason },
      });
    }
  }

  async accept(challengedId: number, challengerId: number): Promise<void> {
    if (!(await this.hub.isPresent("notifications", challengerId))) {
      await this.fastify.pg.query(
        `DELETE FROM challenges WHERE "challengerId" = $1 AND "challengedId" = $2`,
        [challengerId, challengedId]
      );
      throw unavailable();
    }

    const game = await this.fastify.pg.transact(async (tx) => {
      // Locks in the order matchmaking takes them (queue rows, then players
      // in id order), before any challenge row: two challenges from one
      // player accepted at once, or an accept racing a pairing, then wait on
      // each other instead of deadlocking
      await tx.query(`DELETE FROM matchmaking WHERE "userId" = ANY($1)`, [[challengerId, challengedId]]);
      // A continuation locks its series before the players (queue rows,
      // series, players: the order a rematch and a game's end take them in).
      // Which series is read first without a lock; the claim below checks
      // the challenge wasn't replaced meanwhile
      const { rows: pending } = await tx.query<{ seriesId: number | null }>(
        `SELECT "seriesId" FROM challenges WHERE "challengerId" = $1 AND "challengedId" = $2`,
        [challengerId, challengedId]
      );
      const seriesId = pending[0]?.seriesId ?? null;
      const continuing = seriesId !== null ? await seriesRepository.lock(tx, seriesId) : null;
      await tx.query(`SELECT 1 FROM users WHERE id = ANY($1) ORDER BY id FOR UPDATE`, [
        [challengerId, challengedId],
      ]);
      const { rows } = await tx.query<Challenge>(
        `DELETE FROM challenges WHERE "challengerId" = $1 AND "challengedId" = $2 RETURNING *`,
        [challengerId, challengedId]
      );
      const challenge = rows[0];
      if (!challenge || Date.now() - new Date(challenge.createdAt).getTime() > CHALLENGE_TTL_MS) {
        throw new AppError("Challenge not found", "CHALLENGE_NOT_FOUND", 404);
      }
      if (challenge.seriesId !== seriesId) {
        throw new AppError("The challenge changed; try again", "CHALLENGE_CHANGED", 409);
      }

      // The challenger may have started another game since sending this
      if ((await gameRepository.findActiveGameIdForUser(tx, challengerId)) !== null) {
        throw unavailable();
      }

      if (continuing) {
        // The next game of an existing series; its colours and clock apply
        if (continuing.status !== "active") throw new AppError("The series is over", "SERIES_OVER", 409);
        if (await seriesRepository.hasGameInProgress(tx, continuing.id)) {
          throw new AppError("A game of this series is being played", "SERIES_GAME_IN_PROGRESS", 409);
        }
        const number = continuing.gamesPlayed + 1;
        const created = await createGame(tx, {
          ...seriesColors(continuing, number),
          time: continuing.time,
          increment: continuing.increment,
          series: { id: continuing.id, game: number },
        });
        await tx.query(
          `DELETE FROM challenges WHERE "challengerId" = ANY($1) OR "challengedId" = ANY($1)`,
          [[challengerId, challengedId]]
        );
        return created;
      }

      const challengerIsWhite = challenge.challengerColor === "white";
      // A best-of challenge starts a series; this is its first game. The
      // series row's foreign keys share-lock both players, so take
      // createGame's lock (id order) first: two transactions holding share
      // locks on the same player would deadlock upgrading them
      if (challenge.bestOf > 1) {
        await tx.query(`SELECT 1 FROM users WHERE id = ANY($1) ORDER BY id FOR UPDATE`, [
          [challengerId, challengedId],
        ]);
      }
      const series =
        challenge.bestOf > 1
          ? await seriesRepository.create(tx, {
              challengerId,
              challengedId,
              challengerColor: challenge.challengerColor,
              bestOf: challenge.bestOf,
              time: challenge.time,
              increment: challenge.increment,
            })
          : null;
      const created = await createGame(tx, {
        whiteId: challengerIsWhite ? challengerId : challengedId,
        blackId: challengerIsWhite ? challengedId : challengerId,
        time: challenge.time,
        increment: challenge.increment,
        ...(series && { series: { id: series.id, game: 1 } }),
      });
      await tx.query(
        `DELETE FROM challenges WHERE "challengerId" = ANY($1) OR "challengedId" = ANY($1)`,
        [[challengerId, challengedId]]
      );
      return created;
    });

    this.fastify.liveGames.watchDeadline(game.id, game.deadlineAt);
    for (const playerId of [game.whiteId, game.blackId]) {
      await this.hub.publish(topics.notifications(playerId), {
        type: "match_created",
        data: matchFoundData(game, playerId),
      });
      await this.hub.publish(topics.notifications(playerId), activeGameMessage(game.id));
    }
  }
}
