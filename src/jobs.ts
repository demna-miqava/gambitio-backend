import type { FastifyInstance } from "fastify";
import { gameRepository } from "./repositories/gameRepository.js";

/**
 * Backstop for the per-game deadline timers (LiveGameService.watchDeadline):
 * catches games another instance was watching when it went away.
 */
const CLOCK_SWEEP_MS = 10_000;
const MATCHMAKING_SWEEP_MS = 2_000;
const CHALLENGE_SWEEP_MS = 30_000;

/**
 * Background timers. Each pass is idempotent and uses row locks, so running
 * them on every server instance at once is safe.
 *
 * A pass only runs when there is something for it to do on this instance
 * (games being watched, players searching, anyone connected), so an idle
 * server sends the database nothing and Neon can suspend it. Games are
 * resolved at their deadline by per-game timers, not by polling.
 */
export function createJobs(app: FastifyInstance) {
  const timers: NodeJS.Timeout[] = [];

  /** Ends games whose clock ran out or whose first move never came. */
  async function runClockSweep(): Promise<void> {
    const ids = await gameRepository.findIdsPastDeadline(app.pg, new Date(), 50);
    for (const id of ids) await app.liveGames.resolveDeadline(id);
  }

  function every(ms: number, name: string, when: () => boolean, fn: () => Promise<void>) {
    let running = false;
    timers.push(
      setInterval(() => {
        if (running || !when()) return;
        running = true;
        fn()
          .catch((err) => app.log.error({ err }, `${name} failed`))
          .finally(() => {
            running = false;
          });
      }, ms)
    );
  }

  return {
    runClockSweep,
    start() {
      app.liveGames
        .startDeadlineTimers()
        .catch((err) => app.log.error({ err }, "Arming game deadline timers failed"));
      every(
        CLOCK_SWEEP_MS,
        "Clock sweep",
        () => app.liveGames.watchedGameCount > 0 || app.hub.attachedCount > 0,
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
        () => app.hub.attachedCount > 0,
        () => app.challenges.expireStale()
      );
    },
    stop() {
      for (const timer of timers) clearInterval(timer);
      timers.length = 0;
      app.liveGames.stopDeadlineTimers();
    },
  };
}
