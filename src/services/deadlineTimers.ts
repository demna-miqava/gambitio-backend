import type { FastifyBaseLogger } from "fastify";

/** Fires a moment after the deadline, so the clock has surely run out. */
const DEADLINE_SLACK_MS = 20;
/** A deadline timer whose resolve failed tries again after this long. */
const DEADLINE_RETRY_MS = 5_000;

/**
 * One timer per live game this instance knows about, set for its deadline
 * (the moment its clock runs out or its first-move window closes), so the
 * database isn't polled to find them. A timer that fires calls `resolve`,
 * which decides the game, or re-arms the timer (watch) for a deadline that
 * has since moved (a move made on another instance).
 *
 * Off until enable(): tests drive the clock by hand. LiveGameService owns
 * one (see watchDeadline).
 */
export class DeadlineTimers {
  private timers = new Map<number, { at: number; timer: NodeJS.Timeout }>();
  private enabled = false;

  constructor(
    private readonly resolve: (gameId: number) => Promise<void>,
    private readonly log: FastifyBaseLogger
  ) {}

  enable(): void {
    this.enabled = true;
  }

  /** Clears every timer and turns them off. */
  stop(): void {
    this.enabled = false;
    for (const id of [...this.timers.keys()]) this.clear(id);
  }

  /** Games with a timer armed. */
  get size(): number {
    return this.timers.size;
  }

  gameIds(): IterableIterator<number> {
    return this.timers.keys();
  }

  /** (Re)arms the game's timer for `at`; null clears it. */
  watch(gameId: number, at: Date | null): void {
    if (!this.enabled) return;
    if (!at) return this.clear(gameId);
    const when = at.getTime();
    if (this.timers.get(gameId)?.at === when) return;
    this.arm(gameId, when, Math.max(0, when - Date.now()) + DEADLINE_SLACK_MS);
  }

  clear(gameId: number): void {
    const entry = this.timers.get(gameId);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.timers.delete(gameId);
  }

  /**
   * Sets the game's timer to resolve its deadline (`when`) in `delayMs`. A
   * resolve that fails (a transient database error, a lock timeout) tries
   * again after DEADLINE_RETRY_MS, unless the timer was re-armed meanwhile.
   */
  private arm(gameId: number, when: number, delayMs: number): void {
    this.clear(gameId);
    const timer = setTimeout(() => {
      this.timers.delete(gameId);
      this.resolve(gameId).catch((err) => {
        this.log.error({ err, gameId }, "Resolving a game deadline failed; retrying");
        if (this.enabled && !this.timers.has(gameId)) {
          this.arm(gameId, when, DEADLINE_RETRY_MS);
        }
      });
    }, delayMs);
    timer.unref();
    this.timers.set(gameId, { at: when, timer });
  }
}
