import type { FastifyInstance } from "fastify";
import { AppError } from "../errors/AppError.js";
import type { Queryable, TxClient } from "../db.js";
import { topics, type RealtimeHub } from "../realtime/hub.js";
import { gameRepository } from "../repositories/gameRepository.js";
import { withinLimit } from "../utils/rateLimit.js";
import { RATED_POOL_SQL } from "./puzzleService.js";
import { DeadlineTimers } from "./deadlineTimers.js";
import {
  DUEL_COUNTDOWN_MS,
  DUEL_INVITE_TTL_MS,
  DUEL_MAX_STRIKES,
  DUEL_MS,
  DUEL_PUZZLE_COUNT,
  allOut,
  duelRatingLadder,
  duelWinner,
  judgeDuelMove,
} from "../game/puzzleDuel.js";

/** Waiting invites one player may have out at once */
export const MAX_PENDING_INVITES = 3;
/** Invites one player may send an hour, so nobody can be flooded */
export const INVITES_PER_HOUR = 20;
/** Fewer puzzles than this and a duel isn't worth starting */
const MIN_PUZZLES = 10;
/** How long past a duel's end this instance keeps sweeping (see needsSweep) */
const SWEEP_GRACE_MS = 2 * 60_000;

interface DuelRow {
  id: number;
  playerOneId: number;
  playerTwoId: number;
  puzzleIds: string[];
  startsAt: Date;
  endsAt: Date;
  status: "active" | "finished";
  endedAt: Date | null;
  endReason: "time" | "both_out" | null;
  winnerId: number | null;
  rematchOf: number | null;
}

interface PlayerRow {
  userId: number;
  username: string;
  avatarUrl: string | null;
  score: number;
  strikes: number;
  current: number;
  progress: string[];
  results: { index: number; solved: boolean }[];
}

interface PuzzleRow {
  id: string;
  fen: string;
  moves: string;
  rating: number;
  themes: string[];
}

export interface DuelInvite {
  id: number;
  createdAt: Date;
  expiresAt: Date;
  from: { id: number; username: string; avatarUrl: string | null };
  to: { id: number; username: string; avatarUrl: string | null };
  rematchOf: number | null;
}

/** The puzzle a player is on: the position and the moves played in it so far, but not its id or solution */
export interface ShownPuzzle {
  index: number;
  fen: string;
  /** UCI: the player's right moves and the replies, to play on top of fen */
  played: string[];
  rating: number;
}

/** A puzzle once it's over for the player (or the duel is): everything about it */
export interface FinishedPuzzle {
  index: number;
  puzzleId: string;
  fen: string;
  solution: string[];
  rating: number;
  themes: string[];
}

const DUEL_COLUMNS = `d.id, d."playerOneId", d."playerTwoId", d."puzzleIds", d."startsAt", d."endsAt", d.status,
  d."endedAt", d."endReason", d."winnerId", d."rematchOf"`;
const PLAYER_COLUMNS = `p."userId", u.username, u."avatarUrl", p.score, p.strikes, p."current", p.progress, p.results`;
const INVITE_SELECT = `SELECT i.id, i."createdAt", i."expiresAt", i."rematchOf",
    json_build_object('id', s.id, 'username', s.username, 'avatarUrl', s."avatarUrl") AS "from",
    json_build_object('id', r.id, 'username', r.username, 'avatarUrl', r."avatarUrl") AS "to"
  FROM puzzle_duel_invites i JOIN users s ON s.id = i."senderId" JOIN users r ON r.id = i."recipientId"`;

export interface DuelState {
  id: number;
  status: "active" | "finished";
  serverNow: number;
  startsAt: number;
  endsAt: number;
  endedAt: number | null;
  endReason: "time" | "both_out" | null;
  winnerId: number | null;
  rematchOf: number | null;
  maxStrikes: number;
  players: {
    userId: number;
    username: string;
    avatarUrl: string | null;
    score: number;
    strikes: number;
    out: boolean;
    results?: { index: number; solved: boolean }[];
  }[];
  puzzle: ShownPuzzle | null;
  finishedPuzzles: FinishedPuzzle[];
}

const notFound = () => new AppError("Duel not found", "DUEL_NOT_FOUND", 404);
const inviteNotFound = () => new AppError("That invite is no longer open", "INVITE_NOT_FOUND", 404);

/** The puzzle's solution as a list of UCI moves */
const lineOf = (puzzle: { moves: string }) => puzzle.moves.split(" ");

/**
 * Puzzle duels: two friends race through the same puzzles, in the same
 * order, for three minutes (src/game/puzzleDuel.ts has the rules).
 *
 * - The server owns the clock and the score and checks every move; a
 *   puzzle's id and solution reach a player only once they are done with it
 *   (or the duel is over), so neither can read the answers off the network.
 * - Puzzles come from the unrated half (RATED_POOL_SQL): the half Rush
 *   already serves with solutions, so nothing rated mode would later serve
 *   to either player is shown, solved or used up. No puzzle rating changes,
 *   and nothing is written to puzzle_attempts or solved_puzzles.
 * - State is in Postgres (migration 046); live updates go to both players'
 *   notifications topics through the hub, so any instance can serve either
 *   player. The clock's end is a timer on the instance that started the
 *   duel, with a sweep in src/jobs.ts as the backstop.
 * - Friends only, never with a block either way; invites expire after
 *   DUEL_INVITE_TTL_MS and are limited per sender.
 */
export class PuzzleDuelService {
  private readonly timers: DeadlineTimers;
  /** Until when this instance may have duels or invites to sweep */
  private sweepUntil = Date.now() + DUEL_INVITE_TTL_MS + SWEEP_GRACE_MS;

  constructor(
    private fastify: FastifyInstance,
    private hub: RealtimeHub
  ) {
    this.timers = new DeadlineTimers((id) => this.finishIfOver(id), fastify.log);
  }

  /** Turns the end-of-clock timers on (off in tests, which call finishIfOver by hand). */
  startTimers(): void {
    this.timers.enable();
  }

  stop(): void {
    this.timers.stop();
  }

  /** Whether the sweep has anything to look at on this instance (see jobs.ts) */
  get needsSweep(): boolean {
    return Date.now() < this.sweepUntil || this.timers.size > 0;
  }

  private noteActivity(until: number): void {
    this.sweepUntil = Math.max(this.sweepUntil, until + SWEEP_GRACE_MS);
  }

  private tell(userId: number, message: object): Promise<void> {
    return this.hub
      .publish(topics.notifications(userId), message)
      .catch((err) => this.fastify.log.error({ err, userId }, "Failed to publish a duel update"));
  }

  // ------------------------------------------------------------------ invites

  /**
   * Whether two players may duel: friends, no block either way, and the
   * other account still exists. Throws why not.
   */
  private async assertMayDuel(db: Queryable, userId: number, otherId: number) {
    const { rows } = await db.query<{ live: boolean; friends: boolean; blocked: boolean }>(
      `SELECT u."clerkId" IS NOT NULL AS live,
         EXISTS (SELECT 1 FROM friends f
           WHERE LEAST(f."userOneId", f."userTwoId") = LEAST($1::int, $2::int)
             AND GREATEST(f."userOneId", f."userTwoId") = GREATEST($1::int, $2::int)) AS friends,
         EXISTS (SELECT 1 FROM user_blocks b
           WHERE (b."blockerId" = $1 AND b."blockedId" = $2) OR (b."blockerId" = $2 AND b."blockedId" = $1)) AS blocked
       FROM users u WHERE u.id = $2`,
      [userId, otherId]
    );
    const row = rows[0];
    if (!row || !row.live) throw new AppError("User not found", "USER_NOT_FOUND", 404);
    // A block reads as not being friends, so it isn't revealed
    if (row.blocked || !row.friends) {
      throw new AppError("You can only duel your friends", "NOT_FRIENDS", 403);
    }
  }

  /** The duel a player is in now, if any */
  async activeDuelId(userId: number, db: Queryable = this.fastify.pg): Promise<number | null> {
    const { rows } = await db.query<{ id: number }>(
      `SELECT d.id FROM puzzle_duel_players p JOIN puzzle_duels d ON d.id = p."duelId"
       WHERE p."userId" = $1 AND d.status = 'active' ORDER BY d.id DESC LIMIT 1`,
      [userId]
    );
    return rows[0]?.id ?? null;
  }

  async invite(senderId: number, recipientId: number, rematchOf?: number): Promise<DuelInvite> {
    if (senderId === recipientId) throw new AppError("You can't duel yourself", "SELF_DUEL", 400);
    await this.assertMayDuel(this.fastify.pg, senderId, recipientId);
    if (rematchOf !== undefined) {
      const { rows } = await this.fastify.pg.query(
        `SELECT 1 FROM puzzle_duels WHERE id = $1 AND status = 'finished'
           AND LEAST("playerOneId", "playerTwoId") = LEAST($2::int, $3::int)
           AND GREATEST("playerOneId", "playerTwoId") = GREATEST($2::int, $3::int)`,
        [rematchOf, senderId, recipientId]
      );
      if (rows.length === 0) throw notFound();
    }
    if ((await this.activeDuelId(senderId)) !== null) {
      throw new AppError("Finish your duel first", "IN_DUEL", 409);
    }
    // Nobody is invited away from a game being played (the invite would pop
    // up over their board), or invites from one. Accepting checks again
    if ((await gameRepository.findActiveGameIdForUser(this.fastify.pg, senderId)) !== null) {
      throw new AppError("Finish your game first", "IN_GAME", 409);
    }
    if ((await gameRepository.findActiveGameIdForUser(this.fastify.pg, recipientId)) !== null) {
      throw new AppError("They're playing a game", "IN_GAME", 409);
    }
    const allowed = await withinLimit(
      this.fastify.redis,
      `duel:invites:${senderId}`,
      INVITES_PER_HOUR,
      60 * 60
    );
    if (!allowed) {
      throw new AppError("You've sent a lot of duel invites. Try again later.", "INVITE_RATE_LIMITED", 429);
    }

    const invite = await this.fastify.pg.transact(async (tx) => {
      // The sender's row: two invites of theirs at once take turns, so the
      // pending limit holds
      await tx.query(`SELECT 1 FROM users WHERE id = $1 FOR NO KEY UPDATE`, [senderId]);
      // Lapsed invites stop counting (and free the pair for a new one)
      await tx.query(
        `UPDATE puzzle_duel_invites SET status = 'expired'
         WHERE "senderId" = $1 AND status = 'pending' AND "expiresAt" <= now()`,
        [senderId]
      );
      const { rows: pending } = await tx.query<{ recipientId: number }>(
        `SELECT "recipientId" FROM puzzle_duel_invites WHERE "senderId" = $1 AND status = 'pending'`,
        [senderId]
      );
      if (pending.some((p) => p.recipientId === recipientId)) {
        throw new AppError("You've already invited this player", "ALREADY_INVITED", 409);
      }
      if (pending.length >= MAX_PENDING_INVITES) {
        throw new AppError(
          `You can have ${MAX_PENDING_INVITES} duel invites waiting at once`,
          "TOO_MANY_INVITES",
          429
        );
      }
      const { rows } = await tx.query<{ id: number }>(
        `INSERT INTO puzzle_duel_invites ("senderId", "recipientId", "expiresAt", "rematchOf")
         VALUES ($1, $2, now() + ($3::int * interval '1 millisecond'), $4) RETURNING id`,
        [senderId, recipientId, DUEL_INVITE_TTL_MS, rematchOf ?? null]
      );
      return (await tx.query<DuelInvite>(`${INVITE_SELECT} WHERE i.id = $1`, [rows[0]!.id])).rows[0]!;
    });

    this.noteActivity(invite.expiresAt.getTime());
    await this.tell(recipientId, { type: "duel_invite", data: invite });
    await this.tell(senderId, { type: "duel_invite_sent", data: invite });
    void this.fastify.push.notify(
      recipientId,
      {
        title: rematchOf ? `${invite.from.username} wants a rematch` : `${invite.from.username} invited you to a puzzle duel`,
        body: "Same puzzles, three minutes, highest score wins.",
        url: "/puzzles/duel",
        tag: `duel-invite-${senderId}`,
      },
      Math.ceil(DUEL_INVITE_TTL_MS / 1000)
    );
    return invite;
  }

  /** Invites waiting for the player, and the ones they sent, newest first */
  async invites(userId: number): Promise<{ incoming: DuelInvite[]; outgoing: DuelInvite[] }> {
    const { rows } = await this.fastify.pg.query<DuelInvite & { senderId: number }>(
      `${INVITE_SELECT} WHERE i.status = 'pending' AND i."expiresAt" > now()
         AND (i."recipientId" = $1 OR i."senderId" = $1)
       ORDER BY i.id DESC`,
      [userId]
    );
    return {
      incoming: rows.filter((r) => r.to.id === userId),
      outgoing: rows.filter((r) => r.from.id === userId),
    };
  }

  /**
   * Accepts an invite: starts the duel. Checked again here: still friends,
   * no block, neither in a duel or a live game.
   */
  async accept(recipientId: number, inviteId: number): Promise<{ duelId: number }> {
    const outcome = await this.fastify.pg.transact(async (tx) => {
      // Who sent it, read without a lock: the players' rows are locked
      // before any invite row, here as everywhere (players, then what is
      // between them). The other way round, two friends accepting each
      // other's invite at the same moment would each hold their invite and
      // wait for the other's, and one would fail on the deadlock
      const { rows: found } = await tx.query<{ senderId: number }>(
        `SELECT "senderId" FROM puzzle_duel_invites WHERE id = $1 AND "recipientId" = $2`,
        [inviteId, recipientId]
      );
      if (!found[0]) throw inviteNotFound();
      const senderId = found[0].senderId;
      // Both players, lowest id first: two accepts involving the same player
      // take turns, so nobody ends up in two duels
      await tx.query(`SELECT 1 FROM users WHERE id = ANY($1::int[]) ORDER BY id FOR NO KEY UPDATE`, [
        [senderId, recipientId],
      ]);
      // Now the invite itself, as it stands once those are held
      const { rows } = await tx.query<{ rematchOf: number | null; open: boolean }>(
        `SELECT "rematchOf", "expiresAt" > now() AS open FROM puzzle_duel_invites
         WHERE id = $1 AND status = 'pending' FOR UPDATE`,
        [inviteId]
      );
      const invite = rows[0];
      if (!invite || !invite.open) {
        // No longer open. If that is because the two are already in a duel
        // (each accepted the other's invite, or rematch, at the same
        // moment: the first accept started it and closed this one), that
        // duel is the answer, not an error
        const { rows: between } = await tx.query<{ id: number }>(
          `SELECT id FROM puzzle_duels WHERE status = 'active'
             AND LEAST("playerOneId", "playerTwoId") = LEAST($1::int, $2::int)
             AND GREATEST("playerOneId", "playerTwoId") = GREATEST($1::int, $2::int)
           ORDER BY id DESC LIMIT 1`,
          [senderId, recipientId]
        );
        if (between[0]) return { existingDuelId: between[0].id };
        throw inviteNotFound();
      }
      await this.assertMayDuel(tx, recipientId, senderId);
      for (const id of [senderId, recipientId]) {
        if ((await this.activeDuelId(id, tx)) !== null) {
          throw new AppError(
            id === recipientId ? "Finish your duel first" : "They're in another duel",
            "IN_DUEL",
            409
          );
        }
        if ((await gameRepository.findActiveGameIdForUser(tx, id)) !== null) {
          throw new AppError(
            id === recipientId ? "Finish your game first" : "They're playing a game",
            "IN_GAME",
            409
          );
        }
      }
      const puzzleIds = await this.pickPuzzles(tx);
      if (puzzleIds.length < MIN_PUZZLES) throw new AppError("No puzzles available", "NO_PUZZLES", 503);
      const { rows: created } = await tx.query<DuelRow>(
        `INSERT INTO puzzle_duels AS d ("playerOneId", "playerTwoId", "puzzleIds", "startsAt", "endsAt", "rematchOf")
         VALUES ($1, $2, $3, now() + ($4::int * interval '1 millisecond'),
                 now() + (($4::int + $5::int) * interval '1 millisecond'), $6)
         RETURNING ${DUEL_COLUMNS}`,
        [senderId, recipientId, puzzleIds, DUEL_COUNTDOWN_MS, DUEL_MS, invite.rematchOf]
      );
      const row = created[0]!;
      await tx.query(
        `INSERT INTO puzzle_duel_players ("duelId", "userId") VALUES ($1, $2), ($1, $3)`,
        [row.id, senderId, recipientId]
      );
      await tx.query(`UPDATE puzzle_duel_invites SET status = 'accepted', "duelId" = $2 WHERE id = $1`, [
        inviteId,
        row.id,
      ]);
      // Other invites between the two are answered by this duel
      await tx.query(
        `UPDATE puzzle_duel_invites SET status = 'cancelled'
         WHERE status = 'pending' AND id <> $1
           AND (("senderId" = $2 AND "recipientId" = $3) OR ("senderId" = $3 AND "recipientId" = $2))`,
        [inviteId, senderId, recipientId]
      );
      return { row };
    });
    // Started a moment ago by the other accept, which has told both players
    if ("existingDuelId" in outcome) return { duelId: outcome.existingDuelId };
    const duel = outcome.row;

    this.timers.watch(duel.id, duel.endsAt);
    this.noteActivity(duel.endsAt.getTime());
    const started = {
      type: "duel_started",
      data: { duelId: duel.id, inviteId, startsAt: duel.startsAt, endsAt: duel.endsAt },
    };
    await this.tell(duel.playerOneId, started);
    await this.tell(duel.playerTwoId, started);
    return { duelId: duel.id };
  }

  /** The recipient says no; the sender is told. */
  async decline(recipientId: number, inviteId: number): Promise<void> {
    const { rows } = await this.fastify.pg.query<{ senderId: number }>(
      `UPDATE puzzle_duel_invites SET status = 'declined'
       WHERE id = $1 AND "recipientId" = $2 AND status = 'pending' RETURNING "senderId"`,
      [inviteId, recipientId]
    );
    if (!rows[0]) throw inviteNotFound();
    const message = { type: "duel_invite_closed", data: { inviteId, status: "declined" } };
    await this.tell(rows[0].senderId, message);
    await this.tell(recipientId, message);
  }

  /** The sender takes it back; the recipient's inbox drops it. */
  async cancel(senderId: number, inviteId: number): Promise<void> {
    const { rows } = await this.fastify.pg.query<{ recipientId: number }>(
      `UPDATE puzzle_duel_invites SET status = 'cancelled'
       WHERE id = $1 AND "senderId" = $2 AND status = 'pending' RETURNING "recipientId"`,
      [inviteId, senderId]
    );
    if (!rows[0]) throw inviteNotFound();
    const message = { type: "duel_invite_closed", data: { inviteId, status: "cancelled" } };
    await this.tell(rows[0].recipientId, message);
    await this.tell(senderId, message);
  }

  /** Marks lapsed invites expired and tells both sides (the sweep). */
  async expireInvites(): Promise<void> {
    const { rows } = await this.fastify.pg.query<{ id: number; senderId: number; recipientId: number }>(
      `UPDATE puzzle_duel_invites SET status = 'expired'
       WHERE id IN (SELECT id FROM puzzle_duel_invites
                    WHERE status = 'pending' AND "expiresAt" <= now() LIMIT 200)
       RETURNING id, "senderId", "recipientId"`
    );
    for (const invite of rows) {
      const message = { type: "duel_invite_closed", data: { inviteId: invite.id, status: "expired" } };
      await this.tell(invite.senderId, message);
      await this.tell(invite.recipientId, message);
    }
  }

  /**
   * The duel's puzzles from the unrated half, one near each rating of the
   * ladder (easiest first), each from a random point among its rating so
   * duels differ. Uses the unrated half's (rating, id) index (migration 031).
   */
  private async pickPuzzles(tx: TxClient): Promise<string[]> {
    const ladder = duelRatingLadder(DUEL_PUZZLE_COUNT);
    const ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
    const starts = ladder.map(() => ALPHABET[Math.floor(Math.random() * ALPHABET.length)]!);
    const { rows } = await tx.query<{ id: string | null }>(
      `SELECT pick.id FROM unnest($1::int[], $2::text[]) WITH ORDINALITY AS l(rating, start, n)
       LEFT JOIN LATERAL (
         SELECT p.id FROM puzzles p
         WHERE NOT (${RATED_POOL_SQL("p")}) AND (p.rating, p.id) >= (l.rating, l.start)
         ORDER BY p.rating, p.id LIMIT 1
       ) pick ON true
       ORDER BY l.n`,
      [ladder, starts]
    );
    const ids: string[] = [];
    for (const { id } of rows) if (id && !ids.includes(id)) ids.push(id);
    if (ids.length >= MIN_PUZZLES) return ids;
    // A small puzzle set (a fresh install): the easiest ones there are
    const { rows: easiest } = await tx.query<{ id: string }>(
      `SELECT p.id FROM puzzles p WHERE NOT (${RATED_POOL_SQL("p")}) ORDER BY p.rating, p.id LIMIT $1`,
      [DUEL_PUZZLE_COUNT]
    );
    return easiest.map((r) => r.id);
  }

  // -------------------------------------------------------------------- play

  private async loadDuel(db: Queryable, duelId: number, lock = ""): Promise<DuelRow | null> {
    const { rows } = await db.query<DuelRow>(`SELECT ${DUEL_COLUMNS} FROM puzzle_duels d WHERE d.id = $1 ${lock}`, [
      duelId,
    ]);
    return rows[0] ?? null;
  }

  private async loadPlayers(db: Queryable, duelId: number): Promise<PlayerRow[]> {
    const { rows } = await db.query<PlayerRow>(
      `SELECT ${PLAYER_COLUMNS} FROM puzzle_duel_players p JOIN users u ON u.id = p."userId"
       WHERE p."duelId" = $1 ORDER BY p."userId"`,
      [duelId]
    );
    return rows;
  }

  private async loadPuzzles(ids: string[]): Promise<Map<string, PuzzleRow>> {
    if (ids.length === 0) return new Map();
    const { rows } = await this.fastify.pg.query<PuzzleRow>(
      `SELECT id, fen, moves, rating, themes FROM puzzles WHERE id = ANY($1::text[])`,
      [ids]
    );
    return new Map(rows.map((r) => [r.id, r]));
  }

  private shown(index: number, puzzle: PuzzleRow, progress: string[]): ShownPuzzle {
    const line = lineOf(puzzle);
    return { index, fen: puzzle.fen, played: line.slice(0, progress.length * 2), rating: puzzle.rating };
  }

  private finished(index: number, puzzle: PuzzleRow): FinishedPuzzle {
    return {
      index,
      puzzleId: puzzle.id,
      fen: puzzle.fen,
      solution: lineOf(puzzle),
      rating: puzzle.rating,
      themes: puzzle.themes,
    };
  }

  /**
   * The duel as `userId` sees it: the clock, both players' scores and
   * strikes, their own current puzzle, and the puzzles they have finished in
   * full. Once the duel is over: both players' results and every puzzle
   * either reached. Only for its two players. Also what a player who comes
   * back gets: the clock never stopped.
   */
  async state(duelId: number, userId: number, settled = false): Promise<DuelState> {
    const duel = await this.loadDuel(this.fastify.pg, duelId);
    if (!duel || (userId !== duel.playerOneId && userId !== duel.playerTwoId)) throw notFound();
    // A duel whose clock ran out on an instance that went away ends here
    if (!settled && duel.status === "active" && duel.endsAt.getTime() <= Date.now()) {
      await this.finishIfOver(duelId);
      return this.state(duelId, userId, true);
    }
    const players = await this.loadPlayers(this.fastify.pg, duelId);
    const me = players.find((p) => p.userId === userId)!;
    const over = duel.status === "finished";
    // Puzzles this player may see in full: the ones they finished (both
    // players' once the duel is over), plus the one they're on
    const reached = over ? Math.max(...players.map((p) => p.current)) : me.current;
    const done = duel.puzzleIds.slice(0, Math.min(reached, duel.puzzleIds.length));
    const currentId = !over && me.strikes < DUEL_MAX_STRIKES ? duel.puzzleIds[me.current] : undefined;
    const puzzles = await this.loadPuzzles(currentId ? [...done, currentId] : done);
    const current = currentId && puzzles.get(currentId);
    return {
      id: duel.id,
      status: duel.status,
      serverNow: Date.now(),
      startsAt: duel.startsAt.getTime(),
      endsAt: duel.endsAt.getTime(),
      endedAt: duel.endedAt?.getTime() ?? null,
      endReason: duel.endReason,
      winnerId: duel.winnerId,
      rematchOf: duel.rematchOf,
      maxStrikes: DUEL_MAX_STRIKES,
      players: players.map((p) => ({
        userId: p.userId,
        username: p.username,
        avatarUrl: p.avatarUrl,
        score: p.score,
        strikes: p.strikes,
        out: p.strikes >= DUEL_MAX_STRIKES || p.current >= duel.puzzleIds.length,
        // Which puzzles each got right: your own as you go, the other's at the end
        ...((over || p.userId === userId) && { results: p.results }),
      })),
      // Not before the countdown ends: nobody gets a head start studying it
      puzzle: current && duel.startsAt.getTime() <= Date.now() ? this.shown(me.current, current, me.progress) : null,
      finishedPuzzles: done.flatMap((id, index) => {
        const puzzle = puzzles.get(id);
        return puzzle ? [this.finished(index, puzzle)] : [];
      }),
    };
  }

  /**
   * A move in the player's current puzzle (UCI; `index` is the puzzle they
   * believe they're on, so a stale move isn't played in the next one).
   * Right: the reply, or the puzzle is solved and scores. Wrong: a strike,
   * and on to the next puzzle. Either way a finished puzzle comes back with
   * its solution, and the next one without. Both players are told the
   * scores; the duel ends if both are out.
   */
  async move(duelId: number, userId: number, index: number, uci: string) {
    const result = await this.fastify.pg.transact(async (tx) => {
      const { rows } = await tx.query<DuelRow & { early: boolean; late: boolean }>(
        `SELECT ${DUEL_COLUMNS}, now() < d."startsAt" AS early, now() >= d."endsAt" AS late
         FROM puzzle_duels d WHERE d.id = $1 FOR SHARE`,
        [duelId]
      );
      const duel = rows[0];
      if (!duel || (userId !== duel.playerOneId && userId !== duel.playerTwoId)) throw notFound();
      if (duel.status !== "active" || duel.late) throw new AppError("The duel is over", "DUEL_OVER", 409);
      if (duel.early) throw new AppError("The duel hasn't started yet", "DUEL_NOT_STARTED", 409);
      const { rows: players } = await tx.query<PlayerRow>(
        `SELECT p."userId", p.score, p.strikes, p."current", p.progress, p.results
         FROM puzzle_duel_players p WHERE p."duelId" = $1 AND p."userId" = $2 FOR UPDATE`,
        [duelId, userId]
      );
      const me = players[0]!;
      if (me.strikes >= DUEL_MAX_STRIKES || me.current >= duel.puzzleIds.length) {
        throw new AppError("You're out of this duel", "DUEL_OUT", 409);
      }
      if (index !== me.current) throw new AppError("That puzzle is over", "STALE_PUZZLE", 409);
      const puzzleId = duel.puzzleIds[me.current]!;
      const { rows: found } = await tx.query<PuzzleRow>(
        `SELECT id, fen, moves, rating, themes FROM puzzles WHERE id = $1`,
        [puzzleId]
      );
      const puzzle = found[0];
      if (!puzzle) throw new AppError("Puzzle not found", "PUZZLE_NOT_FOUND", 404);
      const outcome = judgeDuelMove(puzzle.fen, lineOf(puzzle), me.progress, uci);
      if (!outcome) throw new AppError("Illegal move", "ILLEGAL_MOVE", 400);

      if (outcome.kind === "continue") {
        await tx.query(
          `UPDATE puzzle_duel_players SET progress = progress || $3::text
           WHERE "duelId" = $1 AND "userId" = $2`,
          [duelId, userId, outcome.move]
        );
        return { duel, outcome, puzzle, score: me.score, strikes: me.strikes, next: me.current };
      }
      const solved = outcome.kind === "solved";
      const { rows: updated } = await tx.query<{ score: number; strikes: number; current: number }>(
        `UPDATE puzzle_duel_players SET
           score = score + $3::int, strikes = strikes + $4::int, "current" = "current" + 1, progress = '{}',
           results = results || jsonb_build_array(jsonb_build_object('index', "current", 'solved', $5::boolean)),
           "outAt" = CASE WHEN strikes + $4::int >= $6 THEN now() ELSE "outAt" END
         WHERE "duelId" = $1 AND "userId" = $2
         RETURNING score, strikes, "current"`,
        [duelId, userId, solved ? 1 : 0, solved ? 0 : 1, solved, DUEL_MAX_STRIKES]
      );
      const after = updated[0]!;
      return { duel, outcome, puzzle, score: after.score, strikes: after.strikes, next: after.current };
    });

    const { duel, outcome, puzzle, score, strikes, next } = result;
    const finishedPuzzle = outcome.kind === "continue" ? null : this.finished(next - 1, puzzle);
    const out = strikes >= DUEL_MAX_STRIKES || next >= duel.puzzleIds.length;
    let nextPuzzle: ShownPuzzle | null = null;
    if (outcome.kind !== "continue" && !out) {
      const upcoming = (await this.loadPuzzles([duel.puzzleIds[next]!])).get(duel.puzzleIds[next]!);
      if (upcoming) nextPuzzle = this.shown(next, upcoming, []);
    }
    if (outcome.kind !== "continue") {
      const progress = { type: "duel_progress", data: { duelId, userId, score, strikes, out } };
      await this.tell(duel.playerOneId, progress);
      await this.tell(duel.playerTwoId, progress);
      if (out) await this.finishIfOver(duelId);
    }
    return {
      outcome: outcome.kind,
      move: outcome.move,
      ...(outcome.kind === "continue" && { reply: outcome.reply }),
      finishedPuzzle,
      nextPuzzle,
      score,
      strikes,
      out,
    };
  }

  /**
   * Ends the duel if its clock has run out or both players are out: the
   * higher score wins, equal scores draw. Idempotent: the timer, a move,
   * the sweep and a late state read may all call it.
   */
  async finishIfOver(duelId: number): Promise<void> {
    const ended = await this.fastify.pg.transact(async (tx) => {
      const { rows } = await tx.query<DuelRow & { late: boolean }>(
        `SELECT ${DUEL_COLUMNS}, now() >= d."endsAt" AS late FROM puzzle_duels d WHERE d.id = $1 FOR UPDATE`,
        [duelId]
      );
      const duel = rows[0];
      if (!duel || duel.status !== "active") return null;
      const players = await this.loadPlayers(tx, duelId);
      const bothOut = allOut(players, duel.puzzleIds.length);
      if (!duel.late && !bothOut) {
        // Not over yet (a timer that fired early, a sweep): wait for the end
        this.timers.watch(duelId, duel.endsAt);
        return null;
      }
      const winnerId = duelWinner(players);
      const endReason = duel.late ? "time" : "both_out";
      await tx.query(
        `UPDATE puzzle_duels SET status = 'finished', "endedAt" = now(), "endReason" = $2, "winnerId" = $3
         WHERE id = $1`,
        [duelId, endReason, winnerId]
      );
      return { duel, winnerId, endReason, players };
    });
    if (!ended) return;
    this.timers.clear(duelId);
    const message = {
      type: "duel_ended",
      data: {
        duelId,
        winnerId: ended.winnerId,
        endReason: ended.endReason,
        scores: ended.players.map((p) => ({ userId: p.userId, score: p.score, strikes: p.strikes })),
      },
    };
    await this.tell(ended.duel.playerOneId, message);
    await this.tell(ended.duel.playerTwoId, message);
  }

  /** The backstop for the timers: duels whose clock ran out, and lapsed invites. */
  async sweep(): Promise<void> {
    const { rows } = await this.fastify.pg.query<{ id: number }>(
      `SELECT id FROM puzzle_duels WHERE status = 'active' AND "endsAt" <= now() ORDER BY "endsAt" LIMIT 50`
    );
    for (const { id } of rows) {
      await this.finishIfOver(id).catch((err) => this.fastify.log.error({ err, duelId: id }, "Ending a duel failed"));
    }
    await this.expireInvites();
  }
}
