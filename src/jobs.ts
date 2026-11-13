import type { FastifyInstance } from "fastify";
import { gameRepository } from "./repositories/gameRepository.js";

const CLOCK_SWEEP_MS = 500;
const MATCHMAKING_SWEEP_MS = 2_000;
const CHALLENGE_SWEEP_MS = 30_000;

/**
 * Background timers. Each pass is idempotent and uses row locks, so running
 * them on every server instance at once is safe.
 */
export function createJobs(app: FastifyInstance) {
  const timers: NodeJS.Timeout[] = [];

  /** Ends games whose clock ran out or whose first move never came. */
  async function runClockSweep(): Promise<void> {
    const ids = await gameRepository.findIdsPastDeadline(app.pg, new Date(), 50);
    for (const id of ids) await app.liveGames.resolveDeadline(id);
  }

  function every(ms: number, name: string, fn: () => Promise<void>) {
    let running = false;
    timers.push(
      setInterval(() => {
        if (running) return;
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
      every(CLOCK_SWEEP_MS, "Clock sweep", runClockSweep);
      every(MATCHMAKING_SWEEP_MS, "Matchmaking sweep", () => app.matchmaking.sweep());
      every(CHALLENGE_SWEEP_MS, "Challenge sweep", () => app.challenges.expireStale());
    },
    stop() {
      for (const timer of timers) clearInterval(timer);
      timers.length = 0;
    },
  };
}
