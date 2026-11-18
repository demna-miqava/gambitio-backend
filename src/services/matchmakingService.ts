import type { FastifyInstance } from "fastify";
import type { MatchmakingRequest } from "../models/Matchmaking.js";
import { getTimeControl, ratingColumns } from "../models/common.js";
import { gameRepository } from "../repositories/gameRepository.js";
import { createGame, lockPlayers, matchFoundData, AlreadyInGameError } from "./gameService.js";
import { timeControlLabel } from "./pushService.js";
import { activeGameMessage, topics, type RealtimeHub } from "../realtime/hub.js";
import { notBlockedSql } from "../repositories/blockRepository.js";
import type { LiveGame } from "../models/Game.js";
import { AppError } from "../errors/AppError.js";

const INITIAL_RATING_RANGE = 50;
const RANGE_STEP = 50;
const RANGE_STEP_EVERY_MS = 5_000;
const MAX_RATING_RANGE = 500;
const MAX_WAIT_MS = 10 * 60_000;
/** Opponents a pairing looks at, in case the first ones' players are gone */
const CANDIDATES_PER_PAIRING = 5;
/** At startup, entries at least this old may be left over (see removeLeftovers) */
const LEFTOVER_AGE_MS = 5_000;

/** Rating window that widens the longer a player has waited. */
export function ratingRangeFor(waitedMs: number): number {
  const steps = Math.floor(Math.max(0, waitedMs) / RANGE_STEP_EVERY_MS);
  return Math.min(INITIAL_RATING_RANGE + steps * RANGE_STEP, MAX_RATING_RANGE);
}

/** ratingRangeFor, in SQL, for the queue row `alias` (the constants are numbers, safe to inline). */
const ratingRangeSql = (alias: string) => `LEAST(
    ${INITIAL_RATING_RANGE} + GREATEST(0, floor(
      EXTRACT(EPOCH FROM (CURRENT_TIMESTAMP - ${alias}."createdAt")) * 1000 / ${RANGE_STEP_EVERY_MS}
    )) * ${RANGE_STEP},
    ${MAX_RATING_RANGE})`;

/**
 * SQL condition: queue row `m` is an opponent the player of queue row `self`
 * may be paired with: another player, the same time control, a rating
 * within `self`'s window (which widens with `self`'s wait), no block between
 * the two, and not in a game. Both are trusted table aliases.
 */
const opponentSql = (self: string, m: string) => `
  ${m}.id <> ${self}.id AND ${m}."userId" <> ${self}."userId"
  AND ${m}.time = ${self}.time AND ${m}.increment = ${self}.increment
  AND ${m}.rating BETWEEN ${self}.rating - ${ratingRangeSql(self)} AND ${self}.rating + ${ratingRangeSql(self)}
  -- Never two players with a block between them
  AND ${notBlockedSql(`${self}."userId"`, `${m}."userId"`)}
  AND NOT EXISTS (
    SELECT 1 FROM games g WHERE g.status = 'in_progress'
      AND (g."whiteId" = ${m}."userId" OR g."blackId" = ${m}."userId"))`;

/**
 * Matchmaking queue backed by the matchmaking table.
 *
 * Pairing runs in a transaction that locks both queue rows with
 * FOR UPDATE SKIP LOCKED, so a waiting player can be claimed by only one
 * opponent even with several server instances. The sweeper retries the
 * waiting requests that have a fitting opponent on a timer, so two players
 * who join at the same moment still find each other, and the rating window
 * widens with wait time. Only players with a matchmaking socket open are
 * paired.
 */
export class MatchmakingService {
  constructor(
    private fastify: FastifyInstance,
    private hub: RealtimeHub
  ) {}

  /**
   * Adds the user to the queue, replacing any older entry. The new row gets a
   * fresh id, so an older socket closing later can't remove it.
   */
  async enqueue(userId: number, time: number, increment: number): Promise<MatchmakingRequest> {
    const request = await this.fastify.pg.transact(async (tx) => {
      const activeGameId = await gameRepository.findActiveGameIdForUser(tx, userId);
      if (activeGameId !== null) throw new AlreadyInGameError(activeGameId);

      const col = ratingColumns(getTimeControl(time)).rating;
      await tx.query(`DELETE FROM matchmaking WHERE "userId" = $1`, [userId]);
      const { rows } = await tx.query<MatchmakingRequest>(
        `INSERT INTO matchmaking ("userId", rating, time, increment)
         SELECT id, "${col}", $2, $3 FROM users WHERE id = $1
         RETURNING id, "createdAt", rating, time, increment, "userId"`,
        [userId, time, increment]
      );
      return rows[0]!;
    });
    return request;
  }

  /** Removes one queue entry (by id, so only the socket that created it can remove it). */
  async cancel(requestId: number): Promise<void> {
    await this.fastify.pg.query(`DELETE FROM matchmaking WHERE id = $1`, [requestId]);
  }

  /** Tries to pair one queue entry. Returns the new game id, if any. */
  async tryMatch(requestId: number): Promise<number | null> {
    return (await this.pair(requestId))?.id ?? null;
  }

  /**
   * Pairs one queue entry with the longest-waiting fitting opponent whose
   * player is still connected, and starts their game.
   *
   * The entry and its candidates come in one query, all locked with SKIP
   * LOCKED (an entry another pairing holds is skipped). Candidates whose
   * player has no matchmaking socket on any live instance (rows left behind
   * by an instance that crashed) are removed instead of being paired.
   */
  private async pair(requestId: number): Promise<LiveGame | null> {
    const created = await this.fastify.pg.transact(async (tx) => {
      const { rows: candidates } = await tx.query<{
        selfId: number;
        selfUserId: number;
        time: number;
        increment: number;
        id: number;
        userId: number;
      }>(
        `WITH self AS MATERIALIZED (
           SELECT id, "userId", rating, time, increment, "createdAt" FROM matchmaking
           WHERE id = $1 FOR UPDATE SKIP LOCKED
         )
         SELECT self.id AS "selfId", self."userId" AS "selfUserId", self.time, self.increment,
                m.id, m."userId"
         FROM self JOIN matchmaking m ON ${opponentSql("self", "m")}
         ORDER BY m."createdAt" LIMIT $2
         FOR UPDATE OF m SKIP LOCKED`,
        [requestId, CANDIDATES_PER_PAIRING]
      );
      // None: the entry is gone, being paired by someone else right now, or
      // has nobody to play yet
      if (candidates.length === 0) return null;

      const gone: number[] = [];
      let opponent: (typeof candidates)[number] | undefined;
      for (const candidate of candidates) {
        if (await this.hub.isPresent("matchmaking", candidate.userId)) {
          opponent = candidate;
          break;
        }
        gone.push(candidate.id);
      }
      if (!opponent) {
        await tx.query(`DELETE FROM matchmaking WHERE id = ANY($1)`, [gone]);
        return null;
      }
      const self = {
        id: opponent.selfId,
        userId: opponent.selfUserId,
        time: opponent.time,
        increment: opponent.increment,
      };

      await tx.query(`DELETE FROM matchmaking WHERE id = ANY($1)`, [[self.id, opponent.id, ...gone]]);
      const pair = [self.userId, opponent.userId];
      // Players after queue rows, the order accepting a challenge takes them in
      const players = await lockPlayers(tx, pair);
      if (players.size < 2) throw new AppError("Player not found", "USER_NOT_FOUND", 404);
      // After the player locks: whether either is in a game now. The open
      // challenges of the two go in the same round trip (they are about to
      // play; a refusal below rolls that back)
      const { rows: active } = await tx.query<{ id: number; whiteId: number; blackId: number }>(
        `WITH dropped AS (
           DELETE FROM challenges WHERE "challengerId" = ANY($1) OR "challengedId" = ANY($1)
         )
         SELECT id, "whiteId", "blackId" FROM games
         WHERE status = 'in_progress' AND ("whiteId" = ANY($1) OR "blackId" = ANY($1))`,
        [pair]
      );
      if (active[0]) throw new AlreadyInGameError(active[0].id);

      const selfIsWhite = Math.random() < 0.5;
      return createGame(
        tx,
        {
          whiteId: selfIsWhite ? self.userId : opponent.userId,
          blackId: selfIsWhite ? opponent.userId : self.userId,
          time: self.time,
          increment: self.increment ?? 0,
        },
        { locked: players }
      );
    });

    if (!created) return null;
    this.fastify.liveGames.watchDeadline(created.id, created.deadlineAt);
    // All at once: publish() delivers locally in call order, and the Redis
    // PUBLISHes go out back to back instead of one round trip each
    await Promise.all(
      [created.whiteId, created.blackId].flatMap((playerId) => [
        this.hub.publish(topics.matchmaking(playerId), {
          type: "match_found",
          data: matchFoundData(created, playerId),
        }),
        this.hub.publish(topics.notifications(playerId), activeGameMessage(created.id)),
      ])
    );
    for (const playerId of [created.whiteId, created.blackId]) {
      // Someone waiting for an opponent has often switched to another tab
      void this.fastify.push.notify(
        playerId,
        {
          title: "Your game has started",
          body: `${timeControlLabel(created.time, created.increment)} against ${
            playerId === created.whiteId ? created.blackUsername : created.whiteUsername
          }. Your clock is running.`,
          url: `/game/${created.id}`,
          tag: `game-${created.id}`,
        },
        60
      );
    }
    return created;
  }

  /**
   * One sweeper pass: drop entries that waited too long, then retry pairing
   * the entries that have someone to play, oldest first.
   *
   * Which entries those are comes from one query, so a pass costs a couple
   * of round trips however many players are searching, plus a pairing
   * attempt per entry that could actually be paired. Only those entries'
   * players are checked for presence (the others harm nobody, and go when
   * their wait is up or once they could be paired): a candidate whose player
   * is gone is removed by pair().
   */
  async sweep(): Promise<void> {
    await this.fastify.pg.query(
      `DELETE FROM matchmaking WHERE "createdAt" <= CURRENT_TIMESTAMP - make_interval(secs => $1)`,
      [MAX_WAIT_MS / 1000]
    );
    const { rows } = await this.fastify.pg.query<{ id: number; userId: number }>(
      `SELECT a.id, a."userId" FROM matchmaking a
       WHERE EXISTS (SELECT 1 FROM matchmaking m WHERE ${opponentSql("a", "m")})
       ORDER BY a."createdAt"`
    );
    // A player paired earlier in this pass has no entry left to try
    const paired = new Set<number>();
    for (const row of rows) {
      if (paired.has(row.userId)) continue;
      if (!(await this.hub.isPresent("matchmaking", row.userId))) {
        await this.cancel(row.id);
        continue;
      }
      try {
        const game = await this.pair(row.id);
        if (game) paired.add(game.whiteId).add(game.blackId);
      } catch (error) {
        if (!(error instanceof AlreadyInGameError)) throw error;
        // The game may be the opponent's (one started since the opponent was
        // picked): only a player who is in a game leaves the queue
        if ((await gameRepository.findActiveGameIdForUser(this.fastify.pg, row.userId)) !== null) {
          await this.cancel(row.id);
        }
      }
    }
  }

  /**
   * Run once at startup: removes queue entries older than a few seconds
   * whose player has no matchmaking socket on any live instance. Those were
   * left by an instance that stopped without closing its sockets (a crash);
   * a player searching on another instance keeps their entry.
   */
  async removeLeftovers(): Promise<void> {
    const { rows } = await this.fastify.pg.query<{ id: number; userId: number }>(
      `SELECT id, "userId" FROM matchmaking WHERE "createdAt" <= CURRENT_TIMESTAMP - make_interval(secs => $1)`,
      [LEFTOVER_AGE_MS / 1000]
    );
    const gone: number[] = [];
    for (const row of rows) {
      if (!(await this.hub.isPresent("matchmaking", row.userId))) gone.push(row.id);
    }
    if (gone.length > 0) await this.fastify.pg.query(`DELETE FROM matchmaking WHERE id = ANY($1)`, [gone]);
  }
}
