import type { FastifyInstance } from "fastify";
import { AppError } from "../errors/AppError.js";
import { gameRepository } from "../repositories/gameRepository.js";
import { AlreadyInGameError, createGame, lockPlayers, matchFoundData } from "./gameService.js";
import type { LiveGame } from "../models/Game.js";
import { activeGameMessage, topics, type RealtimeHub } from "../realtime/hub.js";
import { getTimeControl, ratingColumns, type PlayerColor } from "../models/common.js";
import { MIRROR_MATCH_LENGTH, seriesColors, seriesOdds } from "../game/series.js";
import { seriesRepository, type SeriesRow } from "./seriesService.js";
import type { AllowedFrom } from "../models/Settings.js";
import { withinLimit } from "../utils/rateLimit.js";
import { clockLabel, timeControlLabel } from "./pushService.js";
import { blocksBetween } from "../repositories/blockRepository.js";
import { openingSummary } from "../game/openings.js";

export interface Challenge {
  id: number;
  createdAt: Date;
  challengerId: number;
  challengedId: number;
  challengerUsername: string;
  challengedUsername: string | null;
  challengerAvatarUrl: string | null;
  challengedAvatarUrl: string | null;
  /** The longer clock when the challenge has time odds */
  time: number;
  increment: number;
  /**
   * Each player's starting clock in seconds when they differ (time odds,
   * migration 027); null for an even game. Such a game is unrated.
   */
  challengerTime: number | null;
  challengedTime: number | null;
  challengerColor: PlayerColor;
  /** 1 for a single game; 3 or 5 for a series; 2 for a mirror match */
  bestOf: number;
  /** Set when accepting plays the next game of an existing series */
  seriesId: number | null;
  /**
   * False for a casual challenge (migration 035): its game, or every game of
   * its series, changes no ratings. Always false with time odds.
   */
  rated: boolean;
  /**
   * The opening its game (or every game of its series) starts from
   * (src/game/openings.ts, migration 036); null for the initial position
   */
  openingId: string | null;
  /**
   * Changes whenever the terms above do (re-sending with other settings),
   * never repeats (migration 030). Accepting can name the version the player
   * saw; a different one is refused with CHALLENGE_CHANGED.
   */
  version: number;
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

/**
 * Limits on challenging, so a challenge (a pop-up, and a push notification
 * for a tab in the background) can't be used to pester:
 *
 * - After a decline the same player can't be challenged again for a while:
 *   a few minutes for someone who isn't a friend, a minute for a friend or
 *   the next game of a series (enough to stop an instant re-ask).
 * - Each (challenger, challenged) pair has its own limit, friends and series
 *   included. Re-sending replaces the open challenge, and normal use (change
 *   the time control, cancel and ask again, play a quick series) stays well
 *   under it.
 * - One player can only challenge so many strangers in a row.
 *
 * All three are counted before the challenged player's availability is
 * checked, so asking "is this player online?" costs the same as a challenge.
 */
const STRANGER_DECLINE_COOLDOWN_SECONDS = 5 * 60;
const FRIEND_DECLINE_COOLDOWN_SECONDS = 60;
const PAIR_CHALLENGES = { max: 8, windowSeconds: 10 * 60 };
const STRANGER_CHALLENGES = { max: 10, windowSeconds: 10 * 60 };
/** Holds the time of the decline (ms), for STRANGER_DECLINE_COOLDOWN_SECONDS */
const declinedKey = (challengerId: number, challengedId: number) =>
  `challenge:declined:${challengerId}:${challengedId}`;

const unavailable = () =>
  new AppError("Player is currently unavailable", "OPPONENT_UNAVAILABLE", 409);

/** The challenge was re-sent with other terms after the player saw it */
const changedError = () =>
  new AppError("The challenge changed. Check the new terms.", "CHALLENGE_CHANGED", 409);

/** A received challenge with the challenger's rating for its time control. */
export type ReceivedChallenge = ChallengeWithSeriesGame & { challengerRating: number };

/**
 * The `challenge_received` message: a challenge as the challenged player
 * sees it. Sent when it arrives, when it is re-sent (new terms, new
 * version), and again when an accept named a version that is no longer the
 * current one.
 */
function challengeReceivedMessage(challenge: ReceivedChallenge) {
  return {
    type: "challenge_received",
    data: {
      id: challenge.id,
      challengerId: challenge.challengerId,
      username: challenge.challengerUsername,
      avatarUrl: challenge.challengerAvatarUrl ?? "",
      rating: challenge.challengerRating,
      time: challenge.time,
      increment: challenge.increment,
      // From the challenged player's point of view
      ownTime: challenge.challengedTime,
      opponentTime: challenge.challengerTime,
      color: challenge.challengerColor === "white" ? "black" : "white",
      bestOf: challenge.bestOf,
      ...(challenge.seriesId !== null && { seriesId: challenge.seriesId, seriesGame: challenge.seriesGame }),
      rated: challenge.rated,
      opening: openingSummary(challenge.openingId),
      version: challenge.version,
      createdAt: new Date(challenge.createdAt).toISOString(),
    },
  };
}

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

  /**
   * With the challenger's current rating for each challenge's time control.
   * `fromId` narrows it to the one challenge from that player.
   */
  async getChallengesReceivedByUser(userId: number, fromId?: number): Promise<ReceivedChallenge[]> {
    const { rows } = await this.fastify.pg.query<
      ChallengeWithSeriesGame & { bulletRating: number; blitzRating: number; rapidRating: number }
    >(
      `SELECT c.*, ${SERIES_GAME_SELECT}, u."bulletRating", u."blitzRating", u."rapidRating"
       FROM challenges c JOIN users u ON u.id = c."challengerId"
       WHERE c."challengedId" = $1 AND c."createdAt" > $2 AND ($3::int IS NULL OR c."challengerId" = $3)
       ORDER BY c."createdAt" DESC`,
      [userId, new Date(Date.now() - CHALLENGE_TTL_MS), fromId ?? null]
    );
    return rows.map(({ bulletRating, blitzRating, rapidRating, ...challenge }) => {
      const ratings = { bulletRating, blitzRating, rapidRating };
      return { ...challenge, challengerRating: ratings[ratingColumns(getTimeControl(challenge.time)).rating] };
    });
  }

  /**
   * Sends the challenged player (all their tabs) the challenge as it stands
   * now, after they tried to accept terms it no longer has. Never throws.
   */
  private async resendCurrent(challengerId: number, challengedId: number): Promise<void> {
    try {
      const [current] = await this.getChallengesReceivedByUser(challengedId, challengerId);
      if (current) await this.hub.publish(topics.notifications(challengedId), challengeReceivedMessage(current));
    } catch (err) {
      this.fastify.log.error({ err }, "Re-sending a changed challenge failed");
    }
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
      /** The challenger's own clock */
      time: number;
      increment: number;
      /** The challenged player's clock, when it differs (time odds) */
      opponentTime?: number | undefined;
      bestOf?: number | undefined;
      /** False for a casual game (or series). Default: rated */
      rated?: boolean | undefined;
      /** Start from this opening (src/game/openings.ts) instead of the initial position */
      openingId?: string | undefined;
      /** Continue this series: its settings replace the ones sent */
      seriesId?: number | undefined;
    }
  ): Promise<void> {
    if (data.challengedId === challenger.id) {
      throw new AppError("You can't challenge yourself", "SELF_CHALLENGE", 400);
    }
    // A block either way rules out any challenge, a series' next game included
    const blocks = await blocksBetween(this.fastify.pg, challenger.id, data.challengedId);
    if (blocks.byFirst) {
      throw new AppError("You've blocked this player. Unblock them to play.", "BLOCKED_BY_YOU", 403);
    }
    // Reads like the setting, so the block isn't revealed
    if (blocks.bySecond) {
      throw new AppError("This player isn't accepting challenges", "CHALLENGES_OFF", 403);
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
      const challengerIsOne = series.playerOneId === challenger.id;
      data = {
        ...data,
        time: (challengerIsOne ? series.playerOneTime : series.playerTwoTime) ?? series.time,
        opponentTime: (challengerIsOne ? series.playerTwoTime : series.playerOneTime) ?? undefined,
        increment: series.increment,
        bestOf: series.bestOf,
        rated: series.rated,
        openingId: series.openingId ?? undefined,
        color: colors.whiteId === challenger.id ? "white" : "black",
      };
    }
    // The next game of a series needs no permission: the two are playing it
    const areFriends = series ? true : await this.assertMayChallenge(challenger.id, data.challengedId);
    const ownGameId = await gameRepository.findActiveGameIdForUser(this.fastify.pg, challenger.id);
    if (ownGameId !== null) throw new AlreadyInGameError(ownGameId);
    // Counted before the availability check, so probing whether someone is
    // online costs a challenge
    await this.assertLimits(challenger.id, data.challengedId, { stranger: !areFriends });
    if (!(await this.isAvailable(data.challengedId))) throw unavailable();

    const challengerColor: PlayerColor =
      data.color === "random" ? (Math.random() < 0.5 ? "white" : "black") : data.color;
    const hasOdds = data.opponentTime !== undefined && data.opponentTime !== data.time;
    const time = hasOdds ? Math.max(data.time, data.opponentTime!) : data.time;
    // Time odds always make the game unrated
    const rated = !hasOdds && data.rated !== false;
    const ratingColumn = ratingColumns(getTimeControl(time)).rating;
    // The schema only lets known ids through; this keeps a bad one out of the table anyway
    const opening = openingSummary(data.openingId);
    if (data.openingId !== undefined && !opening) {
      throw new AppError("Unknown opening", "UNKNOWN_OPENING", 400);
    }

    // Sending again to the same player replaces the open challenge (new
    // settings, fresh expiry), so a client that lost track of it isn't
    // stuck. Its version changes only if the terms did: re-sending the same
    // challenge doesn't make a player's accept fail
    const { rows } = await this.fastify.pg.query<Challenge & { challengerRating: number }>(
      `INSERT INTO challenges (
         "challengerId", "challengedId", "challengerUsername", "challengedUsername",
         "challengerAvatarUrl", "challengedAvatarUrl", time, increment, "challengerColor", "bestOf", "seriesId",
         "challengerTime", "challengedTime", rated, "openingId")
       SELECT $1, u.id, $2, u.username, $3, u."avatarUrl", $4, $5, $6, $8, $9, $10, $11, $12, $13
       FROM users u WHERE u.id = $7
       ON CONFLICT ("challengerId", "challengedId") DO UPDATE SET
         version = CASE
           WHEN (challenges.time, challenges.increment, challenges."challengerColor", challenges."bestOf",
                 challenges."seriesId", challenges."challengerTime", challenges."challengedTime", challenges.rated,
                 challenges."openingId")
             IS NOT DISTINCT FROM
                (EXCLUDED.time, EXCLUDED.increment, EXCLUDED."challengerColor", EXCLUDED."bestOf",
                 EXCLUDED."seriesId", EXCLUDED."challengerTime", EXCLUDED."challengedTime", EXCLUDED.rated,
                 EXCLUDED."openingId")
           THEN challenges.version
           ELSE nextval('challenges_version_seq')
         END,
         time = EXCLUDED.time, increment = EXCLUDED.increment,
         "challengerColor" = EXCLUDED."challengerColor", "bestOf" = EXCLUDED."bestOf",
         "seriesId" = EXCLUDED."seriesId", "challengerTime" = EXCLUDED."challengerTime",
         "challengedTime" = EXCLUDED."challengedTime", rated = EXCLUDED.rated, "openingId" = EXCLUDED."openingId",
         "challengerUsername" = EXCLUDED."challengerUsername",
         "challengerAvatarUrl" = EXCLUDED."challengerAvatarUrl", "createdAt" = now()
       RETURNING *, (SELECT "${ratingColumn}" FROM users WHERE id = $1) AS "challengerRating"`,
      [
        challenger.id,
        challenger.username,
        challenger.avatarUrl,
        time,
        data.increment,
        challengerColor,
        data.challengedId,
        data.bestOf ?? 1,
        series?.id ?? null,
        hasOdds ? data.time : null,
        hasOdds ? data.opponentTime : null,
        rated,
        opening?.id ?? null,
      ]
    );
    const challenge = rows[0];
    if (!challenge) throw new AppError("Challenged user not found", "USER_NOT_FOUND", 404);
    // Keeps the challenge sweep running until this one can have expired
    this.fastify.jobs.noteChallenge();

    await this.hub.publish(
      topics.notifications(data.challengedId),
      challengeReceivedMessage({ ...challenge, seriesGame: series ? series.gamesPlayed + 1 : null })
    );
    // For a tab in the background. Only useful while the challenge is open.
    // The push service sends one per challenger and minute at most, so
    // re-sending with new terms doesn't buzz the phone each time
    void this.fastify.push.notify(
      data.challengedId,
      {
        title: `${challenger.username} challenged you`,
        body:
          (challenge.challengedTime !== null && challenge.challengerTime !== null
            ? `Time odds: you get ${clockLabel(challenge.challengedTime)}, they get ` +
              `${clockLabel(challenge.challengerTime)}` +
              (challenge.increment ? `, +${challenge.increment}s a move` : "")
            : `${timeControlLabel(challenge.time, challenge.increment)}`) +
          (challenge.bestOf === MIRROR_MATCH_LENGTH
            ? ", mirror match"
            : challenge.bestOf > 1
              ? `, best of ${challenge.bestOf}`
              : "") +
          (opening ? `, from the ${opening.name}` : "") +
          // Time odds already say so above
          (!challenge.rated && challenge.challengedTime === null ? ", unrated" : "") +
          `. You play ${challengerColor === "white" ? "Black" : "White"}.`,
        url: "/home",
        tag: `challenge-${challenger.id}`,
      },
      CHALLENGE_TTL_MS / 1000
    );
  }

  /**
   * Whether the challenged player's settings let this player challenge them
   * (throws if not). Returns whether the two are friends.
   */
  private async assertMayChallenge(challengerId: number, challengedId: number): Promise<boolean> {
    const { rows } = await this.fastify.pg.query<{ allowed: AllowedFrom; areFriends: boolean }>(
      `SELECT COALESCE(s."challengesAllowedFrom", 'everyone') AS allowed,
         EXISTS (
           SELECT 1 FROM friends f
           WHERE LEAST(f."userOneId", f."userTwoId") = LEAST($1::int, $2::int)
             AND GREATEST(f."userOneId", f."userTwoId") = GREATEST($1::int, $2::int)
         ) AS "areFriends"
       FROM users u LEFT JOIN user_settings s ON s."userId" = u.id
       WHERE u.id = $2::int AND u."clerkId" IS NOT NULL -- not a deleted account`,
      [challengerId, challengedId]
    );
    const target = rows[0];
    if (!target) throw new AppError("Challenged user not found", "USER_NOT_FOUND", 404);
    if (target.allowed === "nobody") {
      throw new AppError("This player isn't accepting challenges", "CHALLENGES_OFF", 403);
    }
    if (target.allowed === "only_friends" && !target.areFriends) {
      throw new AppError("This player only accepts challenges from friends", "NOT_FRIENDS", 403);
    }
    return target.areFriends;
  }

  /**
   * See PAIR_CHALLENGES and the cooldowns above it. Throws when the
   * challenger has to wait; otherwise counts this challenge.
   */
  private async assertLimits(
    challengerId: number,
    challengedId: number,
    { stranger }: { stranger: boolean }
  ): Promise<void> {
    const declined = await this.fastify.redis.get(declinedKey(challengerId, challengedId));
    if (declined !== null) {
      const declinedAt = Number(declined) > 1e12 ? Number(declined) : null;
      const cooldownSeconds = stranger ? STRANGER_DECLINE_COOLDOWN_SECONDS : FRIEND_DECLINE_COOLDOWN_SECONDS;
      // A key without a time ("1") was written by code from before the
      // friend cooldown (or an instance still running it): it applies as it
      // did then, to strangers for as long as the key lives, and not to
      // friends or a series
      const recent = declinedAt === null ? stranger : Date.now() - declinedAt < cooldownSeconds * 1000;
      if (recent) {
        throw new AppError(
          stranger
            ? "This player declined your challenge. You can ask again in a few minutes."
            : "This player declined your challenge. You can ask again in a minute.",
          "CHALLENGE_DECLINED_RECENTLY",
          429
        );
      }
    }
    const rateLimited = () =>
      new AppError("You've sent a lot of challenges. Try again in a few minutes.", "CHALLENGE_RATE_LIMITED", 429);
    const pairAllowed = await withinLimit(
      this.fastify.redis,
      `challenge:pair:${challengerId}:${challengedId}`,
      PAIR_CHALLENGES.max,
      PAIR_CHALLENGES.windowSeconds
    );
    if (!pairAllowed) throw rateLimited();
    if (!stranger) return;
    const allowed = await withinLimit(
      this.fastify.redis,
      `challenge:strangers:${challengerId}`,
      STRANGER_CHALLENGES.max,
      STRANGER_CHALLENGES.windowSeconds
    );
    if (!allowed) throw rateLimited();
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
      // The cooldown depends on whether the two are friends, which is
      // looked at when the next challenge comes (see assertLimits); the key
      // lasts as long as the longer one
      await this.fastify.redis
        .set(declinedKey(challengerId, challengedId), String(Date.now()), {
          expiration: { type: "EX", value: STRANGER_DECLINE_COOLDOWN_SECONDS },
        })
        .catch((err) => this.fastify.log.warn({ err }, "Recording a declined challenge failed"));
      await Promise.all([
        this.hub.publish(topics.notifications(challengerId), {
          type: "challenge_declined",
          data: { challengedId },
        }),
        // The decliner's other tabs drop the challenge too
        this.hub.publish(topics.notifications(challengedId), {
          type: "challenge_cancelled",
          data: { challengerId, reason: "declined" },
        }),
      ]);
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
    // All at once: publish() delivers locally in call order, and the Redis
    // PUBLISHes go out back to back instead of one round trip each
    await Promise.all(
      rows.flatMap(({ challengerId, challengedId }) => [
        this.hub.publish(topics.notifications(challengedId), {
          type: "challenge_cancelled",
          data: { challengerId },
        }),
        this.hub.publish(topics.notifications(challengerId), {
          type: "challenge_declined",
          data: { challengedId, reason },
        }),
      ])
    );
  }

  /**
   * Accepts a challenge and starts its game. `version` is the version of the
   * challenge the player saw (clients that predate versions leave it out):
   * if the challenger has changed the terms since, nothing starts, the
   * player gets CHALLENGE_CHANGED and the challenge as it now stands.
   */
  async accept(challengedId: number, challengerId: number, version?: number): Promise<void> {
    if (!(await this.hub.isPresent("notifications", challengerId))) {
      await this.fastify.pg.query(
        `DELETE FROM challenges WHERE "challengerId" = $1 AND "challengedId" = $2`,
        [challengerId, challengedId]
      );
      throw unavailable();
    }

    const pair = [challengerId, challengedId];
    let game: LiveGame;
    try {
      game = await this.fastify.pg.transact(async (tx) => {
        // Locks in the order matchmaking takes them (queue rows, then players
        // in id order), before any challenge row: two challenges from one
        // player accepted at once, or an accept racing a pairing, then wait on
        // each other instead of deadlocking.
        //
        // A continuation locks its series before the players (queue rows,
        // series, players: the order a rematch and a game's end take them
        // in). Which series is read in the same round trip as the queue rows
        // are taken, without a lock; the claim below checks the challenge
        // wasn't replaced meanwhile
        const { rows: pending } = await tx.query<{ seriesId: number | null }>(
          `WITH dequeued AS (DELETE FROM matchmaking WHERE "userId" = ANY($3))
           SELECT "seriesId" FROM challenges WHERE "challengerId" = $1 AND "challengedId" = $2`,
          [challengerId, challengedId, pair]
        );
        const seriesId = pending[0]?.seriesId ?? null;
        const continuing = seriesId !== null ? await seriesRepository.lock(tx, seriesId) : null;
        const players = await lockPlayers(tx, pair);
        // One statement, after the player locks: claims this challenge and
        // drops every other open challenge of the two (they are about to be
        // in a game; a refusal below rolls that back), and reads whether
        // either player, or the series, has a game in progress
        const { rows } = await tx.query<
          Challenge & { challengerGameId: number | null; challengedGameId: number | null; seriesBusy: boolean }
        >(
          `WITH dropped AS (
             DELETE FROM challenges WHERE "challengerId" = ANY($3) OR "challengedId" = ANY($3)
             RETURNING *
           )
           SELECT d.*,
             (SELECT id FROM games WHERE status = 'in_progress' AND ("whiteId" = $1 OR "blackId" = $1)
              LIMIT 1) AS "challengerGameId",
             (SELECT id FROM games WHERE status = 'in_progress' AND ("whiteId" = $2 OR "blackId" = $2)
              LIMIT 1) AS "challengedGameId",
             EXISTS (SELECT 1 FROM games WHERE "seriesId" = d."seriesId" AND status = 'in_progress')
               AS "seriesBusy"
           FROM dropped d WHERE d."challengerId" = $1 AND d."challengedId" = $2`,
          [challengerId, challengedId, pair]
        );
        const claimed = rows[0];
        if (!claimed || Date.now() - new Date(claimed.createdAt).getTime() > CHALLENGE_TTL_MS) {
          throw new AppError("Challenge not found", "CHALLENGE_NOT_FOUND", 404);
        }
        const { challengerGameId, challengedGameId, seriesBusy, ...challenge } = claimed;
        if (challenge.seriesId !== seriesId || (version !== undefined && challenge.version !== version)) {
          throw changedError();
        }

        // The challenger may have started another game since sending this
        if (challengerGameId !== null) throw unavailable();
        // A deleted account can still have an open challenge for a moment
        if (!players.has(challengerId) || !players.has(challengedId)) {
          throw new AppError("Player not found", "USER_NOT_FOUND", 404);
        }

        if (continuing) {
          // The next game of an existing series; its colours and clock apply
          if (continuing.status !== "active") throw new AppError("The series is over", "SERIES_OVER", 409);
          if (seriesBusy) {
            throw new AppError("A game of this series is being played", "SERIES_GAME_IN_PROGRESS", 409);
          }
        }
        if (challengedGameId !== null) throw new AlreadyInGameError(challengedGameId);

        // The players are locked and neither is in a game: createGame
        // doesn't need to check again
        const locked = { locked: players };
        if (continuing) {
          const number = continuing.gamesPlayed + 1;
          const colors = seriesColors(continuing, number);
          return createGame(
            tx,
            {
              ...colors,
              time: continuing.time,
              increment: continuing.increment,
              odds: seriesOdds(continuing, colors),
              rated: continuing.rated,
              openingId: continuing.openingId,
              series: { id: continuing.id, game: number },
            },
            locked
          );
        }

        const challengerIsWhite = challenge.challengerColor === "white";
        const odds =
          challenge.challengerTime !== null && challenge.challengedTime !== null
            ? { challengerTime: challenge.challengerTime, challengedTime: challenge.challengedTime }
            : null;
        // A best-of challenge starts a series; this is its first game. The
        // series row's foreign keys share-lock both players, which is why
        // they were locked (for update) above, before anything else could
        // take a share lock on them
        const series =
          challenge.bestOf > 1
            ? await seriesRepository.create(tx, {
                challengerId,
                challengedId,
                challengerColor: challenge.challengerColor,
                bestOf: challenge.bestOf,
                time: challenge.time,
                increment: challenge.increment,
                odds,
                rated: challenge.rated,
                openingId: challenge.openingId,
              })
            : null;
        return createGame(
          tx,
          {
            whiteId: challengerIsWhite ? challengerId : challengedId,
            blackId: challengerIsWhite ? challengedId : challengerId,
            time: challenge.time,
            increment: challenge.increment,
            odds: odds && {
              whiteTime: challengerIsWhite ? odds.challengerTime : odds.challengedTime,
              blackTime: challengerIsWhite ? odds.challengedTime : odds.challengerTime,
            },
            rated: challenge.rated,
            openingId: challenge.openingId,
            ...(series && { series: { id: series.id, game: 1 } }),
          },
          locked
        );
      });
    } catch (error) {
      // The player accepted terms that are no longer the challenge's: show
      // them the current ones (the challenge is still open, nothing changed)
      if (error instanceof AppError && error.code === "CHALLENGE_CHANGED") {
        await this.resendCurrent(challengerId, challengedId);
      }
      throw error;
    }

    this.fastify.liveGames.watchDeadline(game.id, game.deadlineAt);
    // All at once: publish() delivers locally in call order (each player
    // gets match_created before active_game), and the Redis PUBLISHes go out
    // back to back instead of one round trip each
    await Promise.all(
      [game.whiteId, game.blackId].flatMap((playerId) => [
        this.hub.publish(topics.notifications(playerId), {
          type: "match_created",
          data: matchFoundData(game, playerId),
        }),
        this.hub.publish(topics.notifications(playerId), activeGameMessage(game.id)),
      ])
    );
    // The challenger may have switched tabs while waiting for the answer
    const data = matchFoundData(game, challengerId);
    void this.fastify.push.notify(
      challengerId,
      {
        title: `${data.opponentUsername} accepted your challenge`,
        body: `Your ${timeControlLabel(game.time, game.increment)} game has started.`,
        url: `/game/${game.id}`,
        tag: `game-${game.id}`,
      },
      60
    );
  }
}
