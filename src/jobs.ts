import type { FastifyInstance } from "fastify";
import { gameRepository } from "./repositories/gameRepository.js";
import { CHALLENGE_TTL_MS } from "./services/challengeService.js";
import { TOURNAMENT_TICK_MS } from "./services/tournamentService.js";

/**
 * Backstop for the per-game deadline timers (LiveGameService.watchDeadline):
 * catches games another instance was watching when it went away.
 */
const CLOCK_SWEEP_MS = 10_000;
const MATCHMAKING_SWEEP_MS = 2_000;
const CHALLENGE_SWEEP_MS = 30_000;
/**
 * Series expire after days, so a pass every half hour is plenty. Kept well
 * apart from Neon's suspend delay (5 minutes without a query): a pass every
 * 5 minutes, as before, kept the database awake for one idle tab.
 */
const SERIES_SWEEP_MS = 30 * 60_000;
/**
 * Backstop for the timers that start a timed match's next game
 * (SeriesService.scheduleNextGame), and ends matches whose time ran out
 * between games
 */
const TIMED_MATCH_SWEEP_MS = 10_000;
/** Chat messages go an hour after their game ends: an hourly pass is close enough */
const CHAT_SWEEP_MS = 60 * 60_000;
/**
 * Backstop for the timers that end puzzle duels (PuzzleDuelService), and
 * the pass that expires their invites
 */
const DUEL_SWEEP_MS = 10_000;

/**
 * Background timers. Each pass is idempotent and uses row locks, so running
 * them on every server instance at once is safe.
 *
 * A pass only runs when there is something for it to do on this instance
 * (live games, players searching, challenges sent here, anyone connected),
 * so an idle server sends the database nothing and Neon can suspend it after
 * its 5 minutes without a query. An open tab alone doesn't count: it keeps
 * a socket open, but sockets don't touch the database. (The pool's idle
 * connections close after 30 seconds, idleTimeoutMillis in app.ts, well
 * within those 5 minutes, so they don't hold the database up either.) Games
 * are resolved at their deadline by per-game timers, not by polling.
 */
export function createJobs(app: FastifyInstance) {
  const timers: NodeJS.Timeout[] = [];
  /** Passes under way, so stop() can wait for them before Redis and Postgres close */
  const inFlight = new Set<Promise<void>>();
  let started = false;

  /**
   * Until when the challenge sweep runs. Challenges are sent over the
   * challenger's notifications socket, so the instance that stored one holds
   * its challenger, and a challenge only outlives its challenger's
   * connection for a short grace (ChallengeService.withdrawIfStillOffline):
   * this instance only has challenges to expire for CHALLENGE_TTL_MS after
   * it last stored one. Starts open for challenges a previous process
   * stored before a restart.
   */
  const challengeWindow = () => Date.now() + CHALLENGE_TTL_MS + 2 * CHALLENGE_SWEEP_MS;
  let challengesUntil = challengeWindow();

  /** Ends games whose clock ran out or whose first move never came. */
  async function runClockSweep(): Promise<void> {
    // The startup read of the live games failed: retry it, so games whose
    // deadline is still ahead get their timers
    if (app.liveGames.liveDeadlinesPending) {
      await app.liveGames
        .armLiveDeadlines()
        .catch((err) => app.log.error({ err }, "Reading live game deadlines failed again"));
    }
    // Games that ended on another instance, so their sockets and timers here
    // stop keeping the sweep (and the database) busy
    await app.liveGames
      .forgetEndedGames()
      .catch((err) => app.log.error({ err }, "Checking for games that ended elsewhere failed"));
    const ids = await gameRepository.findIdsPastDeadline(app.pg, new Date(), 50);
    // One game that fails to resolve (it comes first again next time, the
    // oldest deadline) must not hold up the others
    for (const id of ids) {
      await app.liveGames
        .resolveDeadline(id)
        .catch((err) => app.log.error({ err, gameId: id }, "Clock sweep: resolving a game failed"));
    }
  }

  function every(ms: number, name: string, when: () => boolean, fn: () => Promise<void>) {
    let running = false;
    timers.push(
      setInterval(() => {
        if (running || !when()) return;
        running = true;
        const pass = fn()
          .catch((err) => app.log.error({ err }, `${name} failed`))
          .finally(() => {
            running = false;
            inFlight.delete(pass);
          });
        inFlight.add(pass);
      }, ms)
    );
  }

  return {
    runClockSweep,
    /** Called when a challenge is stored, so the challenge sweep runs until it can expire. */
    noteChallenge() {
      challengesUntil = challengeWindow();
    },
    /** Safe to call more than once: only the first call starts anything. */
    start() {
      if (started) return;
      started = true;
      app.liveGames
        .startDeadlineTimers()
        .catch((err) => app.log.error({ err }, "Arming game deadline timers failed"));
      // Queue entries an instance that crashed left behind
      app.matchmaking
        .removeLeftovers()
        .catch((err) => app.log.error({ err }, "Removing leftover matchmaking entries failed"));
      // Only while there are live games this instance knows of (a timer or
      // a player's socket here, or a failed startup read of them: see
      // LiveGameService.needsClockSweep), or another instance is running
      // (its games are the ones the sweep is for). An instance that dies
      // without the others noticing in time leaves its games to its own
      // restart, which arms a timer for every live game.
      every(
        CLOCK_SWEEP_MS,
        "Clock sweep",
        () => app.liveGames.needsClockSweep || app.hub.othersAlive,
        runClockSweep
      );
      every(
        MATCHMAKING_SWEEP_MS,
        "Matchmaking sweep",
        () => app.hub.presenceCount("matchmaking") > 0,
        () => app.matchmaking.sweep()
      );
      every(
        CHALLENGE_SWEEP_MS,
        "Challenge sweep",
        () => Date.now() < challengesUntil && app.hub.attachedCount > 0,
        () => app.challenges.expireStale()
      );
      every(
        SERIES_SWEEP_MS,
        "Series sweep",
        () => app.hub.attachedCount > 0,
        () => app.series.expireStale()
      );
      // Timed matches: only while this instance knows of one that is on
      // (SeriesService.needsTimedSweep)
      app.series
        .loadTimedMatches()
        .catch((err) => app.log.error({ err }, "Reading the active timed matches failed"));
      every(
        TIMED_MATCH_SWEEP_MS,
        "Timed match sweep",
        () => app.series.needsTimedSweep,
        () => app.series.sweepTimedMatches()
      );
      // Tournaments: start the ones that are due, pair the waiting players
      // of the running ones, close the ones whose time is up. Only while
      // this instance knows of one that is running or about to start
      // (TournamentService.needsTick), so an idle server asks nothing.
      app.tournaments
        .loadOpen()
        .catch((err) => app.log.error({ err }, "Reading the open tournaments failed"));
      every(
        TOURNAMENT_TICK_MS,
        "Tournament tick",
        () => app.tournaments.needsTick,
        () => app.tournaments.tick()
      );
      every(
        CHAT_SWEEP_MS,
        "Chat sweep",
        () => app.hub.attachedCount > 0,
        () => app.gameChat.sweep()
      );
      // Puzzle duels: only while this instance started one, sent an invite,
      // or has a timer armed (PuzzleDuelService.needsSweep), or another
      // instance is running (its duels may need ending if it went away)
      app.puzzleDuels.startTimers();
      every(
        DUEL_SWEEP_MS,
        "Puzzle duel sweep",
        () => app.puzzleDuels.needsSweep || (app.hub.othersAlive && app.hub.attachedCount > 0),
        () => app.puzzleDuels.sweep()
      );
    },
    /** Stops the timers at once; resolves when the passes already under way have finished. */
    async stop(): Promise<void> {
      for (const timer of timers) clearInterval(timer);
      timers.length = 0;
      app.liveGames.stop();
      app.series.stop();
      app.puzzleDuels.stop();
      await Promise.all(inFlight);
    },
  };
}
