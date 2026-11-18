import type { FastifyInstance } from "fastify";
import type { Queryable } from "../db.js";
import { isUniqueViolation } from "../db.js";
import { AppError } from "../errors/AppError.js";
import type { LiveGame } from "../models/Game.js";
import type {
  Standing,
  Tournament,
  TournamentPlayer,
  TournamentPlayerStatus,
  TournamentState,
  TournamentStatus,
  TournamentSummary,
} from "../models/Tournament.js";
import { pairKey, tournamentRepository } from "../repositories/tournamentRepository.js";
import { lastPairingMs, outcomeFor, pairArena, scoreGame } from "../game/arena.js";
import type { GameResult } from "../game/engine.js";
import { chatLength, stripInvisibleText } from "../game/chatText.js";
import { activeGameMessage, topics, type RealtimeHub } from "../realtime/hub.js";
import { createGame, findActiveGames, lockPlayers, matchFoundData } from "./gameService.js";
import { withinLimit } from "../utils/rateLimit.js";

/** What a tournament may be set up with (the create form offers a subset). */
export const TOURNAMENT_LIMITS = {
  nameMin: 3,
  nameMax: 60,
  /** Starting clock, seconds */
  minTime: 30,
  maxTime: 30 * 60,
  maxIncrement: 30,
  /** Length, minutes */
  minMinutes: 10,
  maxMinutes: 180,
  /** How far ahead a tournament can be scheduled */
  maxLeadMs: 7 * 24 * 60 * 60 * 1000,
  minPlayers: 2,
  maxPlayers: 200,
} as const;

/**
 * Tournaments one player can create a day. One can be open at a time, so
 * this is what stops create-cancel-create from filling the table (the
 * route's own limit is per minute).
 */
export const TOURNAMENTS_PER_DAY = { max: 10, windowSeconds: 24 * 60 * 60 };

/** How long a tournament waits past its start for a second player before it is called off. */
export const START_GRACE_MS = 5 * 60_000;
/** How often the tick runs while a tournament is on or due (src/jobs.ts). */
export const TOURNAMENT_TICK_MS = 3_000;
/** Lines of the standings the lobby gets; the rest is paged */
export const STANDINGS_TOP = 20;
const LIVE_GAMES_SHOWN = 10;
/**
 * Open tournaments one read takes (at startup, and the due ones each tick).
 * One per creator can be open, so this is far above what is ever on.
 */
const OPEN_READ_LIMIT = 500;
/** Players one pairing pass reads; more than that wait for the next pass */
const WAITING_PER_PASS = 500;
/** The lobby gets the standings at most once per this long (see noteChanged). */
const STANDINGS_EVERY_MS = 2_000;

/**
 * `requeueDelayMs`: how long after a game a player is left alone before
 * they can be paired again, so there is a moment to look at how it ended
 * (the next pairing pass adds up to a tick). Mutable so tests can make it 0.
 */
export const tournamentTimings = { requeueDelayMs: 5_000 };
/** Players told by push notification that their tournament has started */
const START_PUSH_LIMIT = 200;

/** Redis set of the sockets on a tournament's lobby; see RealtimeHub.addMembership. */
export const tournamentPresenceKey = (tournamentId: number) => `tournament:${tournamentId}:present`;

const notFound = () => new AppError("Tournament not found", "TOURNAMENT_NOT_FOUND", 404);
const closed = () => new AppError("This tournament is over", "TOURNAMENT_CLOSED", 409);
const notIn = () => new AppError("You aren't in this tournament", "NOT_IN_TOURNAMENT", 409);
const noAccount = () => new AppError("Player not found", "USER_NOT_FOUND", 404);

export interface CreateTournamentInput {
  name: string;
  /** Starting clock, seconds */
  time: number;
  increment: number;
  /** How long the tournament runs, minutes */
  minutes: number;
  startsAt: Date;
  rated: boolean;
  maxPlayers: number;
}

/** A name as stored: no invisible characters, single spaces, trimmed. */
export function cleanTournamentName(raw: string): string {
  return stripInvisibleText(raw).replace(/\s+/g, " ").trim();
}

/** A player's line as the lobby shows it to them: someone who left before playing has none. */
const ownLine = (me: Standing | null): Standing | null =>
  me && (me.status !== "withdrawn" || me.games > 0) ? me : null;

/** What a finished game gave each player, for the game's own "game_ended" message. */
export interface TournamentGameResult {
  tournamentId: number;
  whitePoints: number;
  blackPoints: number;
}

/**
 * Locks the tournament rows of a tournament game's two players, in user id
 * order. The end of a game takes them before the players' own rows
 * (finishGame), the order the pairing pass takes them in too.
 */
export async function lockTournamentPlayers(tx: Queryable, game: LiveGame): Promise<TournamentPlayer[]> {
  if (game.tournamentId === null) return [];
  return tournamentRepository.lockPlayers(tx, game.tournamentId, [game.whiteId, game.blackId]);
}

/**
 * Writes a finished tournament game onto its players' rows (`rows`, from
 * lockTournamentPlayers in this transaction): points, streak, the score
 * sheet. A player who is still in goes back into the pairing queue while the
 * tournament has time left, after a short breather
 * (tournamentTimings.requeueDelayMs).
 *
 * `noShowUserId` is the player who never made their first move, if that is
 * how the game ended: they are paused, so they aren't paired again and
 * again while away. An aborted game scores nothing for either side.
 */
export async function recordTournamentResult(
  tx: Queryable,
  game: LiveGame,
  result: GameResult,
  rows: TournamentPlayer[],
  options: { noShowUserId?: number | null; now: Date }
): Promise<TournamentGameResult | null> {
  if (game.tournamentId === null) return null;
  const tournament = await tournamentRepository.find(tx, game.tournamentId);
  const requeue =
    tournament !== null && tournament.status === "running" && options.now.getTime() < tournament.endsAt.getTime();

  const points = { white: 0, black: 0 };
  for (const color of ["white", "black"] as const) {
    const userId = color === "white" ? game.whiteId : game.blackId;
    const row = rows.find((r) => r.userId === userId);
    if (!row) continue;
    const outcome = outcomeFor(result, color);
    const scored = outcome
      ? scoreGame(row, outcome, color === "white" ? game.blackRating : game.whiteRating)
      : null;
    if (scored) points[color] = scored.points;
    const status: TournamentPlayerStatus =
      row.status === "active" && options.noShowUserId === userId ? "paused" : row.status;
    await tournamentRepository.saveGame(tx, game.tournamentId, userId, scored, {
      status,
      waitingSince:
        status === "active" && requeue
          ? new Date(options.now.getTime() + tournamentTimings.requeueDelayMs)
          : null,
    });
  }
  return { tournamentId: game.tournamentId, whitePoints: points.white, blackPoints: points.black };
}

/**
 * Arena tournaments: creating and joining them, and the three things the
 * tick does for one that is open (start it, pair its waiting players, close
 * it). Rules are in src/game/arena.ts; a finished game is scored in the
 * game's own transaction (recordTournamentResult).
 *
 * Nothing about a tournament lives only in memory. Every instance may run
 * the tick: the tournament's row lock decides who does the work.
 */
export class TournamentService {
  /** Open tournaments this instance knows of: what `needsTick` reads, so an idle server asks the database nothing */
  private watched = new Map<number, { status: TournamentStatus; startsAt: number }>();
  /** Per tournament, the standings throttle window (see STANDINGS_EVERY_MS) */
  private windows = new Map<number, { timer: NodeJS.Timeout; pending: boolean; changed: Set<number> }>();
  /** Set while the startup read of the open tournaments hasn't succeeded (see loadOpen) */
  private openUnread = false;

  constructor(
    private fastify: FastifyInstance,
    private hub: RealtimeHub
  ) {}

  /** Remembers an open tournament (or forgets one that has closed). */
  watch(tournament: Pick<Tournament, "id" | "status" | "startsAt">): void {
    if (tournament.status === "scheduled" || tournament.status === "running") {
      this.watched.set(tournament.id, { status: tournament.status, startsAt: tournament.startsAt.getTime() });
    } else {
      this.watched.delete(tournament.id);
    }
  }

  /**
   * Reads the open tournaments at startup, so one created before a restart
   * still starts on time. If the read fails (the database was still waking
   * up), the tick runs anyway and tries it again until it succeeds:
   * otherwise this instance would know of no tournament, and one whose
   * players aren't here yet would start late or not at all.
   */
  async loadOpen(): Promise<void> {
    try {
      const open = await tournamentRepository.findOpen(this.fastify.pg, OPEN_READ_LIMIT);
      this.openUnread = false;
      for (const tournament of open) this.watch(tournament);
    } catch (err) {
      this.openUnread = true;
      throw err;
    }
  }

  /**
   * Whether the tick has anything to do: a tournament this instance knows of
   * is running, or about to start (or the startup read of them failed and
   * is to be tried again).
   */
  get needsTick(): boolean {
    if (this.openUnread) return true;
    const soon = Date.now() + TOURNAMENT_TICK_MS;
    for (const entry of this.watched.values()) {
      if (entry.status === "running" || entry.startsAt <= soon) return true;
    }
    return false;
  }

  stop(): void {
    for (const { timer } of this.windows.values()) clearTimeout(timer);
    this.windows.clear();
  }

  /** Forgets every tournament this instance was watching (tests, after the tables are emptied). */
  clear(): void {
    this.stop();
    this.watched.clear();
    this.openUnread = false;
  }

  /**
   * One pass over the tournaments that are running or due to start: starts
   * the due ones, pairs the waiting players of the running ones, closes the
   * ones whose time is up. Safe to run on every instance at once.
   */
  async tick(now = new Date()): Promise<void> {
    if (this.openUnread) await this.loadOpen();
    const due = await tournamentRepository.findDue(this.fastify.pg, now, OPEN_READ_LIMIT);
    const dueIds = new Set(due.map((t) => t.id));
    // What we thought was due and no longer is has closed elsewhere. Not
    // when the list was cut short: one missing from it may just be past the cut
    if (due.length < OPEN_READ_LIMIT) {
      for (const [id, entry] of this.watched) {
        if ((entry.status === "running" || entry.startsAt <= now.getTime()) && !dueIds.has(id)) this.watched.delete(id);
      }
    }
    for (const tournament of due) {
      this.watch(tournament);
      try {
        if (tournament.status === "scheduled") await this.start(tournament.id, now);
        else if (now.getTime() >= tournament.endsAt.getTime()) await this.finish(tournament.id, now);
        else await this.pair(tournament.id, now);
      } catch (err) {
        this.fastify.log.error({ err, tournamentId: tournament.id }, "Tournament tick failed");
      }
    }
  }

  /**
   * Creates a tournament; its creator is its first player. One open
   * tournament per creator (the unique index of migration 034).
   */
  async create(userId: number, input: CreateTournamentInput, now = new Date()): Promise<TournamentState> {
    const name = cleanTournamentName(input.name);
    const length = chatLength(name);
    if (length < TOURNAMENT_LIMITS.nameMin || length > TOURNAMENT_LIMITS.nameMax) {
      throw new AppError(
        `The name must be ${TOURNAMENT_LIMITS.nameMin} to ${TOURNAMENT_LIMITS.nameMax} characters`,
        "INVALID_TOURNAMENT_NAME",
        400
      );
    }
    if (input.startsAt.getTime() > now.getTime() + TOURNAMENT_LIMITS.maxLeadMs) {
      throw new AppError("A tournament can start at most a week from now", "INVALID_TOURNAMENT_START", 400);
    }
    // "Now", or a time that passed while the form was open, is now
    const startsAt = new Date(Math.max(input.startsAt.getTime(), now.getTime()));
    const endsAt = new Date(startsAt.getTime() + input.minutes * 60_000);

    let created: Tournament;
    try {
      created = await this.fastify.pg.transact(async (tx) => {
        const tournament = await tournamentRepository.insert(tx, {
          createdBy: userId,
          name,
          time: input.time,
          increment: input.increment,
          rated: input.rated,
          startsAt,
          endsAt,
          maxPlayers: input.maxPlayers,
        });
        await tournamentRepository.join(tx, tournament.id, userId, null);
        // Not for an account that has just been deleted (see holdAccount)
        if (!(await tournamentRepository.holdAccount(tx, userId))) throw noAccount();
        // Counted once the insert has got past the one-open-tournament
        // index, so only tournaments that would exist count; over the limit
        // this one is rolled back. Without Redis the limit is skipped
        // rather than nobody being able to create one.
        const allowed = await withinLimit(
          this.fastify.redis,
          `tournaments:created:${userId}`,
          TOURNAMENTS_PER_DAY.max,
          TOURNAMENTS_PER_DAY.windowSeconds
        ).catch((err) => {
          this.fastify.log.warn({ err }, "Tournament creation limit unavailable");
          return true;
        });
        if (!allowed) {
          throw new AppError(
            "You've created a lot of tournaments today. Try again tomorrow.",
            "TOURNAMENT_RATE_LIMITED",
            429
          );
        }
        return tournament;
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new AppError(
          "You already have a tournament that is open. It has to finish, or be cancelled, first.",
          "TOURNAMENT_LIMIT",
          409
        );
      }
      throw error;
    }
    this.watch(created);
    return this.getState(created.id, userId);
  }

  /** Calls a tournament off: its creator, before it has started. */
  async cancel(tournamentId: number, userId: number, now = new Date()): Promise<void> {
    await this.fastify.pg.transact(async (tx) => {
      const tournament = await tournamentRepository.lock(tx, tournamentId);
      if (!tournament) throw notFound();
      if (tournament.createdBy !== userId) {
        throw new AppError("Only its creator can cancel a tournament", "NOT_TOURNAMENT_CREATOR", 403);
      }
      if (tournament.status !== "scheduled") {
        throw new AppError("A tournament can only be cancelled before it starts", "TOURNAMENT_STARTED", 409);
      }
      await tournamentRepository.setStatus(tx, tournamentId, "cancelled", now);
    });
    this.watched.delete(tournamentId);
    await this.publishTournament(tournamentId);
  }

  async list(filter: "open" | "finished", viewerId: number, page: number, limit: number) {
    const { data, total } = await tournamentRepository.list(
      this.fastify.pg,
      filter,
      viewerId,
      limit,
      (page - 1) * limit
    );
    return { data, pagination: { page, limit, total, totalPages: Math.ceil(total / limit) } };
  }

  /** Everything the lobby shows, for one viewer. */
  async getState(tournamentId: number, viewerId: number): Promise<TournamentState> {
    const db = this.fastify.pg;
    const tournament = await tournamentRepository.summary(db, tournamentId);
    if (!tournament) throw notFound();
    const [standings, standingsTotal, liveGames, me, myGameId] = await Promise.all([
      tournamentRepository.standings(db, tournament, STANDINGS_TOP, 0),
      tournamentRepository.countListed(db, tournamentId),
      tournamentRepository.liveGames(db, tournamentId, LIVE_GAMES_SHOWN),
      tournamentRepository.standingOf(db, tournament, viewerId),
      tournament.status === "running" ? tournamentRepository.liveGameOf(db, tournamentId, viewerId) : null,
    ]);
    return { tournament, standings, standingsTotal, liveGames, me: ownLine(me), myGameId };
  }

  /**
   * The viewer's own line and game, without the rest of the lobby: what a
   * player further down than the lines the lobby is sent asks for when the
   * standings change (the "standings" message has everything else).
   */
  async getMine(tournamentId: number, viewerId: number): Promise<Pick<TournamentState, "me" | "myGameId">> {
    const db = this.fastify.pg;
    const tournament = await tournamentRepository.find(db, tournamentId);
    if (!tournament) throw notFound();
    const [me, myGameId] = await Promise.all([
      tournamentRepository.standingOf(db, tournament, viewerId),
      tournament.status === "running" ? tournamentRepository.liveGameOf(db, tournamentId, viewerId) : null,
    ]);
    return { me: ownLine(me), myGameId };
  }

  async standingsPage(tournamentId: number, page: number, limit: number) {
    const tournament = await tournamentRepository.find(this.fastify.pg, tournamentId);
    if (!tournament) throw notFound();
    const [data, total] = await Promise.all([
      tournamentRepository.standings(this.fastify.pg, tournament, limit, (page - 1) * limit),
      tournamentRepository.countListed(this.fastify.pg, tournamentId),
    ]);
    return { data, pagination: { page, limit, total, totalPages: Math.ceil(total / limit) } };
  }

  /**
   * Joins a tournament that is scheduled or running, or comes back to it
   * (after a pause, or after leaving: the score is kept). In a running one
   * the player starts waiting for a game at once.
   */
  async join(tournamentId: number, userId: number, now = new Date()): Promise<Standing | null> {
    const tournament = await this.fastify.pg.transact(async (tx) => {
      // The lock makes joins take turns, so the count can't pass the limit
      const locked = await tournamentRepository.lock(tx, tournamentId);
      if (!locked) throw notFound();
      const running = locked.status === "running" && now.getTime() < locked.endsAt.getTime();
      if (locked.status !== "scheduled" && !running) throw closed();
      const existing = await tournamentRepository.findPlayer(tx, tournamentId, userId);
      const takesAPlace = !existing || existing.status === "withdrawn";
      if (takesAPlace && locked.playerCount >= locked.maxPlayers) {
        throw new AppError("This tournament is full", "TOURNAMENT_FULL", 409);
      }
      await tournamentRepository.join(tx, tournamentId, userId, running ? now : null);
      // Not for an account that has just been deleted: its row would stay
      // in the standings as a player nobody can pair (see holdAccount)
      if (!(await tournamentRepository.holdAccount(tx, userId))) throw noAccount();
      return locked;
    });
    this.watch(tournament);
    this.noteChanged(tournamentId, [userId]);
    return tournamentRepository.standingOf(this.fastify.pg, tournament, userId);
  }

  /** Stops being paired, keeping the place in the standings. A game under way is played out. */
  async pause(tournamentId: number, userId: number): Promise<Standing | null> {
    const tournament = await this.fastify.pg.transact(async (tx) => {
      const found = await tournamentRepository.find(tx, tournamentId);
      if (!found) throw notFound();
      if (found.status !== "scheduled" && found.status !== "running") throw closed();
      const [player] = await tournamentRepository.lockPlayers(tx, tournamentId, [userId]);
      if (!player || player.status === "withdrawn") throw notIn();
      await tournamentRepository.setPlayerStatus(tx, tournamentId, userId, "paused", null);
      return found;
    });
    this.noteChanged(tournamentId, [userId]);
    return tournamentRepository.standingOf(this.fastify.pg, tournament, userId);
  }

  /**
   * Leaves the tournament. Someone who hasn't played is simply gone; someone
   * who has stays in the standings with what they scored. A game under way
   * is played out and still counts.
   */
  async withdraw(tournamentId: number, userId: number): Promise<void> {
    await this.fastify.pg.transact(async (tx) => {
      const tournament = await tournamentRepository.lock(tx, tournamentId);
      if (!tournament) throw notFound();
      if (tournament.status !== "scheduled" && tournament.status !== "running") throw closed();
      const [player] = await tournamentRepository.lockPlayers(tx, tournamentId, [userId]);
      if (!player || player.status === "withdrawn") throw notIn();
      const playing =
        tournament.status === "running" &&
        (await tournamentRepository.liveGameOf(tx, tournamentId, userId)) !== null;
      if (player.games === 0 && !playing) await tournamentRepository.removePlayer(tx, tournamentId, userId);
      else await tournamentRepository.setPlayerStatus(tx, tournamentId, userId, "withdrawn", null);
      await tournamentRepository.addToCount(tx, tournamentId, -1);
    });
    this.noteChanged(tournamentId, [userId]);
  }

  /**
   * Starts a tournament whose time has come, if two players are in. With
   * fewer it waits START_GRACE_MS for a second one, then is called off.
   * Returns the status it now has (null: not there, or another instance is
   * working on it).
   */
  async start(tournamentId: number, now = new Date()): Promise<TournamentStatus | null> {
    // Whether this call is the one that changed it (and so announces it)
    let changed = false;
    const status = await this.fastify.pg.transact(async (tx) => {
      const tournament = await tournamentRepository.tryLock(tx, tournamentId);
      if (!tournament) return null;
      if (tournament.status !== "scheduled" || tournament.startsAt.getTime() > now.getTime()) {
        return tournament.status;
      }
      const players = await tournamentRepository.countActive(tx, tournamentId);
      if (players >= TOURNAMENT_LIMITS.minPlayers && now.getTime() < tournament.endsAt.getTime()) {
        await tournamentRepository.setStatus(tx, tournamentId, "running", now);
        await tournamentRepository.queueActive(tx, tournamentId, now);
        changed = true;
        return "running" as const;
      }
      if (now.getTime() >= tournament.startsAt.getTime() + START_GRACE_MS) {
        await tournamentRepository.setStatus(tx, tournamentId, "cancelled", now);
        changed = true;
        return "cancelled" as const;
      }
      return tournament.status;
    });
    if (status === "cancelled") this.watched.delete(tournamentId);
    else if (status === "running") this.watched.set(tournamentId, { status, startsAt: now.getTime() });
    if (changed) {
      await this.publishTournament(tournamentId);
      if (status === "running") void this.notifyStarted(tournamentId);
    }
    return status;
  }

  /**
   * A push notification to the players of a tournament that has just
   * started: most joined a while ago and are in another tab, and only
   * players with the lobby open get games. Never throws.
   */
  private async notifyStarted(tournamentId: number): Promise<void> {
    try {
      const tournament = await tournamentRepository.find(this.fastify.pg, tournamentId);
      if (!tournament) return;
      const userIds = await tournamentRepository.activePlayerIds(this.fastify.pg, tournamentId, START_PUSH_LIMIT);
      for (const userId of userIds) {
        await this.fastify.push.notify(
          userId,
          {
            title: `${tournament.name} has started`,
            body: "Open the tournament to get your first game.",
            url: `/tournaments/${tournamentId}`,
            tag: `tournament-${tournamentId}`,
          },
          // Worth delivering for a while: joining late is fine
          10 * 60
        );
      }
    } catch (err) {
      this.fastify.log.error({ err, tournamentId }, "Failed to announce a tournament's start");
    }
  }

  /**
   * One pairing pass: starts a game for every two waiting players who are
   * connected (arena.pairArena decides who meets whom). Returns the ids of
   * the games it started.
   *
   * Locks, in the order every path takes them: the tournament (skipped if
   * another instance has it: that one is pairing), the waiting players'
   * tournament rows, then the users' rows, all of them in one statement in
   * id order so a game of two of them ending at the same moment can't
   * deadlock with this.
   */
  async pair(tournamentId: number, now = new Date()): Promise<number[]> {
    const games = await this.fastify.pg.transact(async (tx) => {
      const tournament = await tournamentRepository.tryLock(tx, tournamentId);
      if (!tournament || tournament.status !== "running") return [];
      // Too close to the end for a game to be worth starting
      if (now.getTime() >= tournament.endsAt.getTime() - lastPairingMs(tournament.time)) return [];

      const waiting = await tournamentRepository.lockWaiting(tx, tournamentId, now, WAITING_PER_PASS);
      if (waiting.length < 2) return [];
      // Only players with the lobby (or a tournament game) open are paired:
      // closing the tab is all it takes to stop getting games
      const present = new Set(await this.hub.memberUserIds(tournamentPresenceKey(tournamentId)));
      const here = waiting.filter((p) => present.has(p.userId));
      if (here.length < 2) return [];

      const ids = here.map((p) => p.userId);
      // A first look, without locks, so someone playing another game isn't
      // paired (and then dropped below, leaving their opponent without one)
      const busy = await findActiveGames(tx, ids);
      const free = here.filter((p) => !busy.has(p.userId));
      if (free.length < 2) return [];
      const blocks = await tournamentRepository.blockedPairs(tx, free.map((p) => p.userId));
      const pairs = pairArena(
        free.map((p) => ({
          userId: p.userId,
          score: p.score,
          performance: p.performance,
          whites: p.whites,
          games: p.games,
          lastOpponentId: p.lastOpponentId,
          waitingSince: p.waitingSince?.getTime() ?? now.getTime(),
        })),
        { blocked: (a, b) => blocks.has(pairKey(a, b)) }
      );
      if (pairs.length === 0) return [];

      const paired = pairs.flatMap((p) => [p.whiteId, p.blackId]);
      // Queue rows before the players' rows, the order matchmaking takes
      // them in: these players are about to play
      await tx.query(`DELETE FROM matchmaking WHERE "userId" = ANY($1)`, [paired]);
      const players = await lockPlayers(tx, paired);
      // Under the locks: whoever started another game since the first look
      const active = await findActiveGames(tx, paired);
      const ready = pairs.filter(
        (p) =>
          players.has(p.whiteId) && players.has(p.blackId) && !active.has(p.whiteId) && !active.has(p.blackId)
      );
      if (ready.length === 0) return [];
      const playing = ready.flatMap((p) => [p.whiteId, p.blackId]);
      await tx.query(`DELETE FROM challenges WHERE "challengerId" = ANY($1) OR "challengedId" = ANY($1)`, [
        playing,
      ]);

      const created: LiveGame[] = [];
      for (const { whiteId, blackId } of ready) {
        const game = await createGame(
          tx,
          {
            whiteId,
            blackId,
            time: tournament.time,
            increment: tournament.increment,
            tournament: { id: tournamentId, rated: tournament.rated },
          },
          { locked: players }
        );
        await tournamentRepository.markPaired(tx, tournamentId, whiteId, blackId);
        created.push(game);
      }
      return created;
    });

    for (const game of games) this.fastify.liveGames.watchDeadline(game.id, game.deadlineAt);
    // The same messages a challenge's game starts with: the app opens the
    // game wherever the player is
    await Promise.all(
      games.flatMap((game) =>
        [game.whiteId, game.blackId].flatMap((playerId) => [
          this.hub.publish(topics.notifications(playerId), {
            type: "match_created",
            data: matchFoundData(game, playerId),
          }),
          this.hub.publish(topics.notifications(playerId), activeGameMessage(game.id)),
        ])
      )
    ).catch((err) => this.fastify.log.error({ err, tournamentId }, "Failed to announce tournament games"));
    if (games.length > 0) {
      // And to the lobby, which every paired player has open (it is what
      // made them count as here): a player whose notifications socket was
      // reconnecting at this moment would otherwise never hear of the game,
      // and lose it for not showing up
      await this.hub
        .publish(topics.tournament(tournamentId), {
          type: "pairings",
          data: { games: games.map((game) => ({ id: game.id, whiteId: game.whiteId, blackId: game.blackId })) },
        })
        .catch((err) => this.fastify.log.error({ err, tournamentId }, "Failed to send pairings to the lobby"));
      this.noteChanged(tournamentId);
    }
    return games.map((game) => game.id);
  }

  /**
   * Closes a tournament whose time is up, once its last game has ended
   * (games in progress at the bell are played out and count). The winner is
   * the top of the standings, if anyone played. Returns whether it closed.
   */
  async finish(tournamentId: number, now = new Date()): Promise<boolean> {
    const finished = await this.fastify.pg.transact(async (tx) => {
      const tournament = await tournamentRepository.tryLock(tx, tournamentId);
      if (!tournament || tournament.status !== "running") return false;
      if (now.getTime() < tournament.endsAt.getTime()) return false;
      if (await tournamentRepository.hasGameInProgress(tx, tournamentId)) return false;
      const [top] = await tournamentRepository.standings(tx, tournament, 1, 0);
      await tournamentRepository.setStatus(tx, tournamentId, "finished", now, top && top.games > 0 ? top.userId : null);
      await tournamentRepository.clearQueue(tx, tournamentId);
      return true;
    });
    if (finished) {
      this.watched.delete(tournamentId);
      await this.publishTournament(tournamentId);
    }
    return finished;
  }

  /**
   * Takes a deleted account out of every open tournament, inside the
   * deletion's transaction, and calls off the ones it created that haven't
   * started. Returns the tournaments to tell about it once that commits.
   */
  async removeUser(tx: Queryable, userId: number, now = new Date()): Promise<number[]> {
    // Every tournament this touches, locked in id order before any is
    // changed, so two accounts deleted at once (each in the other's
    // tournament) wait for each other instead of deadlocking
    await tournamentRepository.lockOpenOf(tx, userId);
    const { rows: cancelled } = await tx.query<{ id: number }>(
      `UPDATE tournaments SET status = 'cancelled', "finishedAt" = $2
       WHERE "createdBy" = $1 AND status = 'scheduled' RETURNING id`,
      [userId, now]
    );
    const left = await tournamentRepository.withdrawEverywhere(tx, userId);
    return [...new Set([...cancelled.map((r) => r.id), ...left])];
  }

  /** After removeUser has committed: the lobbies hear about it. */
  async announceRemoval(tournamentIds: number[]): Promise<void> {
    for (const id of tournamentIds) {
      const tournament = await tournamentRepository.find(this.fastify.pg, id).catch(() => null);
      if (!tournament) continue;
      this.watch(tournament);
      await this.publishTournament(id);
    }
  }

  /**
   * Tells the lobby the standings changed, at most once per
   * STANDINGS_EVERY_MS: a change within the window goes out at its end, as
   * the standings are then, so the last change is always sent. Never throws.
   *
   * `userIds`: the players whose own line changed (their game ended; they
   * joined, paused or left). The message names them, so a player too far
   * down to be in it knows when to ask for their line, instead of everyone
   * down there asking every time anything changes.
   */
  noteChanged(tournamentId: number, userIds: readonly number[] = []): void {
    const window = this.windows.get(tournamentId);
    if (window) {
      window.pending = true;
      for (const userId of userIds) window.changed.add(userId);
      return;
    }
    this.openWindow(tournamentId);
    void this.publishStandings(tournamentId, userIds);
  }

  private openWindow(tournamentId: number): void {
    const timer = setTimeout(() => {
      const window = this.windows.get(tournamentId);
      this.windows.delete(tournamentId);
      if (!window?.pending) return;
      this.openWindow(tournamentId);
      void this.publishStandings(tournamentId, [...window.changed]);
    }, STANDINGS_EVERY_MS);
    timer.unref();
    this.windows.set(tournamentId, { timer, pending: false, changed: new Set() });
  }

  /**
   * Sends the lobby the top of the standings and the games being played,
   * with the players whose own line changed (`changed`, see noteChanged).
   * Never throws.
   */
  async publishStandings(tournamentId: number, changed: readonly number[] = []): Promise<void> {
    try {
      const tournament = await tournamentRepository.find(this.fastify.pg, tournamentId);
      if (!tournament) return;
      const [standings, standingsTotal, liveGames] = await Promise.all([
        tournamentRepository.standings(this.fastify.pg, tournament, STANDINGS_TOP, 0),
        tournamentRepository.countListed(this.fastify.pg, tournamentId),
        tournamentRepository.liveGames(this.fastify.pg, tournamentId, LIVE_GAMES_SHOWN),
      ]);
      await this.hub.publish(topics.tournament(tournamentId), {
        type: "standings",
        data: { standings, standingsTotal, liveGames, playerCount: tournament.playerCount, changed },
      });
    } catch (err) {
      this.fastify.log.error({ err, tournamentId }, "Failed to publish tournament standings");
    }
  }

  /** Sends the lobby the tournament itself (it started, ended or was called off), then the standings. Never throws. */
  async publishTournament(tournamentId: number): Promise<void> {
    try {
      const tournament: TournamentSummary | null = await tournamentRepository.summary(
        this.fastify.pg,
        tournamentId
      );
      if (!tournament) return;
      await this.hub.publish(topics.tournament(tournamentId), { type: "tournament", data: { tournament } });
    } catch (err) {
      this.fastify.log.error({ err, tournamentId }, "Failed to publish a tournament update");
    }
    await this.publishStandings(tournamentId);
  }
}
