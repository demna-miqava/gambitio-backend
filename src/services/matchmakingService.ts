import type { FastifyInstance } from "fastify";
import type { MatchmakingRequest } from "../models/Matchmaking.js";
import { getTimeControl, ratingColumns } from "../models/common.js";
import { gameRepository } from "../repositories/gameRepository.js";
import { createGame, matchFoundData, AlreadyInGameError } from "./gameService.js";
import { topics, type RealtimeHub } from "../realtime/hub.js";

const INITIAL_RATING_RANGE = 50;
const RANGE_STEP = 50;
const RANGE_STEP_EVERY_MS = 5_000;
const MAX_RATING_RANGE = 500;
const MAX_WAIT_MS = 10 * 60_000;

/** Rating window that widens the longer a player has waited. */
export function ratingRangeFor(waitedMs: number): number {
  const steps = Math.floor(Math.max(0, waitedMs) / RANGE_STEP_EVERY_MS);
  return Math.min(INITIAL_RATING_RANGE + steps * RANGE_STEP, MAX_RATING_RANGE);
}

/**
 * Matchmaking queue backed by the matchmaking table.
 *
 * Pairing runs in a transaction that locks both queue rows with
 * FOR UPDATE SKIP LOCKED, so a waiting player can be claimed by only one
 * opponent even with several server instances. The sweeper retries every
 * waiting request on a timer, so two players who join at the same moment
 * still find each other, and the rating window widens with wait time.
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
    const created = await this.fastify.pg.transact(async (tx) => {
      const { rows: selfRows } = await tx.query<MatchmakingRequest & { waitedMs: number }>(
        `SELECT id, "userId", rating, time, increment,
                EXTRACT(EPOCH FROM (CURRENT_TIMESTAMP - "createdAt")) * 1000 AS "waitedMs"
         FROM matchmaking WHERE id = $1 FOR UPDATE SKIP LOCKED`,
        [requestId]
      );
      const self = selfRows[0];
      if (!self) return null; // gone, or being paired by someone else right now

      const range = ratingRangeFor(Number(self.waitedMs));
      const { rows: opponentRows } = await tx.query<MatchmakingRequest>(
        `SELECT m.id, m."userId" FROM matchmaking m
         WHERE m.id <> $1 AND m."userId" <> $2 AND m.time = $3 AND m.increment = $4
           AND m.rating BETWEEN $5 AND $6
           AND NOT EXISTS (
             SELECT 1 FROM games g WHERE g.status = 'in_progress'
               AND (g."whiteId" = m."userId" OR g."blackId" = m."userId"))
         ORDER BY m."createdAt" LIMIT 1
         FOR UPDATE OF m SKIP LOCKED`,
        [self.id, self.userId, self.time, self.increment, self.rating - range, self.rating + range]
      );
      const opponent = opponentRows[0];
      if (!opponent) return null;

      await tx.query(`DELETE FROM matchmaking WHERE id = ANY($1)`, [[self.id, opponent.id]]);
      const selfIsWhite = Math.random() < 0.5;
      const game = await createGame(tx, {
        whiteId: selfIsWhite ? self.userId : opponent.userId,
        blackId: selfIsWhite ? opponent.userId : self.userId,
        time: self.time,
        increment: self.increment ?? 0,
      });
      await tx.query(
        `DELETE FROM challenges WHERE "challengerId" = ANY($1) OR "challengedId" = ANY($1)`,
        [[self.userId, opponent.userId]]
      );
      return game;
    });

    if (!created) return null;
    for (const playerId of [created.whiteId, created.blackId]) {
      await this.hub.publish(topics.matchmaking(playerId), {
        type: "match_found",
        data: matchFoundData(created, playerId),
      });
    }
    return created.id;
  }

  /**
   * One sweeper pass: drop entries whose player is gone or waited too long,
   * then retry pairing everyone still waiting, oldest first.
   */
  async sweep(): Promise<void> {
    const { rows } = await this.fastify.pg.query<{ id: number; userId: number; waitedMs: number }>(
      `SELECT id, "userId", EXTRACT(EPOCH FROM (CURRENT_TIMESTAMP - "createdAt")) * 1000 AS "waitedMs"
       FROM matchmaking ORDER BY "createdAt"`
    );
    for (const row of rows) {
      const stale =
        Number(row.waitedMs) > MAX_WAIT_MS ||
        !(await this.hub.isPresent("matchmaking", row.userId));
      if (stale) {
        await this.cancel(row.id);
        continue;
      }
      try {
        await this.tryMatch(row.id);
      } catch (error) {
        if (error instanceof AlreadyInGameError) await this.cancel(row.id);
        else throw error;
      }
    }
  }
}
