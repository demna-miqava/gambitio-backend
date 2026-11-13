import type { FastifyInstance } from "fastify";
import { AppError } from "../errors/AppError.js";
import { gameRepository } from "../repositories/gameRepository.js";
import { AlreadyInGameError, createGame, matchFoundData } from "./gameService.js";
import { activeGameMessage, topics, type RealtimeHub } from "../realtime/hub.js";
import { getTimeControl, ratingColumns, type PlayerColor } from "../models/common.js";

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
}

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
  async getChallengeSentByUser(userId: number): Promise<Challenge | null> {
    const { rows } = await this.fastify.pg.query<Challenge>(
      `SELECT * FROM challenges WHERE "challengerId" = $1 AND "createdAt" > $2
       ORDER BY "createdAt" DESC LIMIT 1`,
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
  async getChallengesReceivedByUser(userId: number): Promise<(Challenge & { challengerRating: number })[]> {
    const { rows } = await this.fastify.pg.query<
      Challenge & { bulletRating: number; blitzRating: number; rapidRating: number }
    >(
      `SELECT c.*, u."bulletRating", u."blitzRating", u."rapidRating"
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
    data: { challengedId: number; color: PlayerColor | "random"; time: number; increment: number }
  ): Promise<void> {
    if (data.challengedId === challenger.id) {
      throw new AppError("You can't challenge yourself", "SELF_CHALLENGE", 400);
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
         "challengerAvatarUrl", "challengedAvatarUrl", time, increment, "challengerColor")
       SELECT $1, u.id, $2, u.username, $3, u."avatarUrl", $4, $5, $6
       FROM users u WHERE u.id = $7
       ON CONFLICT ("challengerId", "challengedId") DO UPDATE SET
         time = EXCLUDED.time, increment = EXCLUDED.increment,
         "challengerColor" = EXCLUDED."challengerColor", "createdAt" = now()
       RETURNING *`,
      [
        challenger.id,
        challenger.username,
        challenger.avatarUrl,
        data.time,
        data.increment,
        challengerColor,
        data.challengedId,
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
        createdAt: new Date(challenge.createdAt).toISOString(),
      },
    });
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
      const { rows } = await tx.query<Challenge>(
        `DELETE FROM challenges WHERE "challengerId" = $1 AND "challengedId" = $2 RETURNING *`,
        [challengerId, challengedId]
      );
      const challenge = rows[0];
      if (!challenge || Date.now() - new Date(challenge.createdAt).getTime() > CHALLENGE_TTL_MS) {
        throw new AppError("Challenge not found", "CHALLENGE_NOT_FOUND", 404);
      }

      // The challenger may have started another game since sending this
      if ((await gameRepository.findActiveGameIdForUser(tx, challengerId)) !== null) {
        throw unavailable();
      }

      const challengerIsWhite = challenge.challengerColor === "white";
      const created = await createGame(tx, {
        whiteId: challengerIsWhite ? challengerId : challengedId,
        blackId: challengerIsWhite ? challengedId : challengerId,
        time: challenge.time,
        increment: challenge.increment,
      });
      await tx.query(
        `DELETE FROM challenges WHERE "challengerId" = ANY($1) OR "challengedId" = ANY($1)`,
        [[challengerId, challengedId]]
      );
      await tx.query(`DELETE FROM matchmaking WHERE "userId" = ANY($1)`, [[challengerId, challengedId]]);
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
