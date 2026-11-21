import type { FastifyInstance } from "fastify";
import type { MatchmakingRequest } from "../models/Matchmaking.js";
import { getTimeControl, ratingColumns } from "../models/common.js";
import { gameRepository } from "../repositories/gameRepository.js";
import { announceGameStart, createGame, lockPlayers, matchFoundData, AlreadyInGameError } from "./gameService.js";
import { timeControlLabel } from "./pushService.js";
import { activeGameMessage, topics, type RealtimeHub } from "../realtime/hub.js";
import { notBlockedSql } from "../repositories/blockRepository.js";
import type { LiveGame } from "../models/Game.js";
import { AppError } from "../errors/AppError.js";
import type { DroppedChallenge } from "./challengeService.js";

const INITIAL_RATING_RANGE = 50;
const RANGE_STEP = 50;
const RANGE_STEP_EVERY_MS = 5_000;
const MAX_RATING_RANGE = 500;
const MAX_WAIT_MS = 10 * 60_000;
/** Opponents a pairing looks at, in case the first ones' players are gone */
const CANDIDATES_PER_PAIRING = 5;
/** At startup, entries at least this old may be left over (see removeLeftovers) */
const LEFTOVER_AGE_MS = 5_000;

/** What one pairing attempt did: started a game (dropping these challenges), found an opponent who can't play, or nothing */
type PairOutcome = { game: LiveGame; dropped: DroppedChallenge[] } | "retry" | null;

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
      // An entry already there (another tab searching) is replaced in the
      // same statement: a delete then an insert let two searches starting
      // at once both insert, and one failed on the one-entry-per-user index
      const { rows } = await tx.query<MatchmakingRequest>(
        `INSERT INTO matchmaking ("userId", rating, time, increment)
         SELECT id, "${col}", $2, $3 FROM users WHERE id = $1
         ON CONFLICT ("userId") DO UPDATE SET id = DEFAULT, "createdAt" = DEFAULT,
           rating = EXCLUDED.rating, time = EXCLUDED.time, increment = EXCLUDED.increment
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
   *
   * Only this entry's own player failing (their account is gone, or they
   * are in a game) throws. An opponent who can't play after all (in a game
   * started since the candidates were read, or a deleted account) loses
   * their entry, and the pairing looks again: the player who was searching
   * keeps searching.
   */
  private async pair(requestId: number): Promise<LiveGame | null> {
    let outcome: PairOutcome = "retry";
    // Each retry removes an entry, so this only ends early in a crowd of them
    for (let attempt = 0; attempt < CANDIDATES_PER_PAIRING && outcome === "retry"; attempt++) {
      outcome = await this.pairOnce(requestId);
    }
    if (outcome === null || outcome === "retry") return null;
    const { game: created, dropped } = outcome;
    // The search page opens the game; the other side of each open challenge
    // of the two hears it is gone
    await announceGameStart(this.fastify, {
      games: [created],
      messages: [created.whiteId, created.blackId].flatMap((playerId) => [
        { topic: topics.matchmaking(playerId), message: { type: "match_found", data: matchFoundData(created, playerId) } },
        { topic: topics.notifications(playerId), message: activeGameMessage(created.id) },
      ]),
      dropped,
    });
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

  /** One pairing attempt (see pair): the game and the challenges it dropped, "retry", or null. */
  private async pairOnce(requestId: number): Promise<PairOutcome> {
    return this.fastify.pg.transact(async (tx) => {
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

      const pair = [self.userId, opponent.userId];
      // Players after queue rows (locked above), the order accepting a
      // challenge takes them in
      const players = await lockPlayers(tx, pair);
      // After the player locks: the games either is in now. When both can
      // play, their open challenges are dropped in the same round trip
      // (they are about to play)
      const { rows: found } = await tx.query<{ gameId: number | null; a: number; b: number }>(
        `WITH busy AS (
           SELECT id, "whiteId", "blackId" FROM games
           WHERE status = 'in_progress' AND ("whiteId" = ANY($1) OR "blackId" = ANY($1))
         ), dropped AS (
           DELETE FROM challenges
           WHERE ("challengerId" = ANY($1) OR "challengedId" = ANY($1)) AND $2 AND NOT EXISTS (SELECT 1 FROM busy)
           RETURNING "challengerId", "challengedId"
         )
         SELECT id AS "gameId", "whiteId" AS a, "blackId" AS b FROM busy
         UNION ALL
         SELECT NULL, "challengerId", "challengedId" FROM dropped`,
        [pair, players.size === 2]
      );
      const busy = new Map<number, number>();
      const dropped: DroppedChallenge[] = [];
      for (const row of found) {
        if (row.gameId === null) dropped.push({ challengerId: row.a, challengedId: row.b });
        else for (const userId of [row.a, row.b]) busy.set(userId, row.gameId);
      }
      if (!players.has(self.userId)) throw new AppError("Player not found", "USER_NOT_FOUND", 404);
      const ownGameId = busy.get(self.userId);
      if (ownGameId !== undefined) throw new AlreadyInGameError(ownGameId);
      if (!players.has(opponent.userId) || busy.has(opponent.userId)) {
        await tx.query(`DELETE FROM matchmaking WHERE id = ANY($1)`, [[opponent.id, ...gone]]);
        return "retry";
      }
      await tx.query(`DELETE FROM matchmaking WHERE id = ANY($1)`, [[self.id, opponent.id, ...gone]]);

      const selfIsWhite = Math.random() < 0.5;
      const game = await createGame(
        tx,
        {
          whiteId: selfIsWhite ? self.userId : opponent.userId,
          blackId: selfIsWhite ? opponent.userId : self.userId,
          time: self.time,
          increment: self.increment ?? 0,
        },
        { locked: players }
      );
      return { game, dropped };
    });
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
        // pair() only throws these for the entry's own player (in a game, or
        // their account is gone): the entry goes, and the pass goes on
        const own = error instanceof AlreadyInGameError || (error instanceof AppError && error.code === "USER_NOT_FOUND");
        if (!own) throw error;
        await this.cancel(row.id);
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
