import type { PlayerColor } from "../models/common.js";

/**
 * Pure chess-clock math. The clock state lives on the game row; these
 * functions only compute from it so they are easy to test.
 *
 * Like Lichess, clocks start after each side's first move: plies 0 and 1 cost
 * no time, but a player who doesn't make their first move within
 * FIRST_MOVE_TIMEOUT_MS gets the game aborted.
 */

export const FIRST_MOVE_TIMEOUT_MS = 30_000;

/**
 * Network delay. A player's clock on their screen starts when the opponent's
 * move reaches them and stops when they move; the server's starts when it
 * receives the opponent's move and stops when this player's move reaches
 * it, so it also counts both trips over the network. With each move the
 * client reports how long the player thought (`thinkMs`); the difference
 * from the server's measure is the delay it claims.
 *
 * The claim can't be checked, so it is only believed as far as the server
 * can back it up (see chargeMove):
 *
 * - Free: the round trip the server measures itself on the player's socket
 *   (WebSocket pings, and the TCP round trip Cloudflare saw at the
 *   handshake), plus LAG_SLACK_MS for jitter.
 * - Budget: anything claimed beyond that comes out of a small per-player
 *   budget, stored on the game row. It starts at INITIAL_LAG_BUDGET_MS,
 *   holds at most LAG_BUDGET_CAP_MS and refills by LAG_BUDGET_REFILL_MS per
 *   move, so an honest player's occasional spike (a slow phone, a Wi-Fi
 *   hiccup) is covered while a modified client that always reports
 *   `thinkMs: 0` gains only about LAG_SLACK_MS + LAG_BUDGET_REFILL_MS per
 *   move once its budget is spent.
 * - Never more than MAX_LAG_COMPENSATION_MS per move, whatever the above.
 *
 * Browsers answer pings on their own, but a client that isn't a browser
 * could answer them late to look farther away than it is (the TCP round
 * trip can't be stretched that way). LiveGameService logs moves claiming
 * much more than measured, with both round trips, to tune these constants
 * and spot such accounts.
 *
 * MAX_LAG_COMPENSATION_MS is also how long the server waits past a flag
 * before ending the game, so a move already on its way still counts.
 */
export const MAX_LAG_COMPENSATION_MS = 1_000;
/** Jitter allowed on top of the measured round trip, free of charge */
export const LAG_SLACK_MS = 50;
/** A player's lag budget at the start of a game (the column default, migration 029) */
export const INITIAL_LAG_BUDGET_MS = 500;
/** Most a lag budget can hold */
export const LAG_BUDGET_CAP_MS = 1_000;
/** Added to the mover's lag budget with every move that reports its time */
export const LAG_BUDGET_REFILL_MS = 50;

/** Time one "give time" click adds to the opponent's clock */
export const GIVE_TIME_MS = 10_000;

/**
 * Most a clock can hold from given time (the longest time control). Keeps a
 * player who clicks without end from growing the clock past what the
 * integer columns hold.
 */
export const MAX_CLOCK_MS = 3 * 60 * 60 * 1000;

export interface ClockState {
  whiteMs: number;
  blackMs: number;
  lastMoveAt: number; // epoch ms
  ply: number; // half-moves played so far
  /** Each player's lag budget (see MAX_LAG_COMPENSATION_MS); INITIAL_LAG_BUDGET_MS when left out */
  whiteLagBudgetMs?: number;
  blackLagBudgetMs?: number;
}

/** What the server knows about how a move was timed, besides when it arrived. */
export interface MoveTiming {
  /** How long the player's own clock ran, as their client reports it */
  thinkMs?: number | undefined;
  /** The round trip to the player the server measured itself, if it has one */
  measuredRttMs?: number | undefined;
}

/** How a move is charged (see chargeMove). */
export interface MoveCharge {
  /** Taken off the mover's clock */
  chargedMs: number;
  /** Delay the client claims: the server's measure minus `thinkMs` (0 without a report) */
  claimedLagMs: number;
  /** Delay forgiven without touching the budget: measured round trip plus slack */
  freeMs: number;
  /** Delay forgiven in all */
  forgivenMs: number;
  /** The mover's lag budget after this move */
  lagBudgetMs: number;
}

export function activeColor(ply: number): PlayerColor {
  return ply % 2 === 0 ? "white" : "black";
}

export function isClockRunning(ply: number): boolean {
  return ply >= 2;
}

/** Time left for both players at `now`. */
export function remainingAt(state: ClockState, now: number): { whiteMs: number; blackMs: number } {
  if (!isClockRunning(state.ply)) {
    return { whiteMs: state.whiteMs, blackMs: state.blackMs };
  }
  const elapsed = Math.max(0, now - state.lastMoveAt);
  return activeColor(state.ply) === "white"
    ? { whiteMs: Math.max(0, state.whiteMs - elapsed), blackMs: state.blackMs }
    : { whiteMs: state.whiteMs, blackMs: Math.max(0, state.blackMs - elapsed) };
}

function moverMs(state: ClockState): number {
  return activeColor(state.ply) === "white" ? state.whiteMs : state.blackMs;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** The mover's lag budget, kept within 0..LAG_BUDGET_CAP_MS whatever is stored. */
function moverBudget(state: ClockState): number {
  const stored = activeColor(state.ply) === "white" ? state.whiteLagBudgetMs : state.blackLagBudgetMs;
  return Number.isFinite(stored) ? clamp(stored!, 0, LAG_BUDGET_CAP_MS) : INITIAL_LAG_BUDGET_MS;
}

/**
 * How the side to move is charged for a move received at `now` (see
 * MAX_LAG_COMPENSATION_MS). The server's measure, less the delay the client
 * claims, as far as the measured round trip plus the mover's lag budget
 * cover it. Without a `thinkMs` report, the server's measure and no change
 * to the budget. Before both first moves nothing is charged.
 */
export function chargeMove(state: ClockState, now: number, timing: MoveTiming = {}): MoveCharge {
  const budget = moverBudget(state);
  const elapsed = Math.max(0, now - state.lastMoveAt);
  const { thinkMs } = timing;
  if (!isClockRunning(state.ply) || thinkMs === undefined || !Number.isFinite(thinkMs)) {
    return {
      chargedMs: isClockRunning(state.ply) ? elapsed : 0,
      claimedLagMs: 0,
      freeMs: 0,
      forgivenMs: 0,
      lagBudgetMs: budget,
    };
  }
  const measured = timing.measuredRttMs;
  const claimedLagMs = Math.max(0, elapsed - thinkMs);
  const freeMs = measured !== undefined && Number.isFinite(measured) && measured >= 0 ? measured + LAG_SLACK_MS : 0;
  const forgivenMs = Math.min(claimedLagMs, MAX_LAG_COMPENSATION_MS, freeMs + budget);
  const spent = Math.max(0, forgivenMs - freeMs);
  return {
    chargedMs: Math.max(0, elapsed - forgivenMs),
    claimedLagMs,
    freeMs,
    forgivenMs,
    lagBudgetMs: Math.min(LAG_BUDGET_CAP_MS, budget - spent + LAG_BUDGET_REFILL_MS),
  };
}

/** Time the side to move is charged for a move received at `now` (see chargeMove). */
export function chargedTime(state: ClockState, now: number, timing?: MoveTiming): number {
  return chargeMove(state, now, timing).chargedMs;
}

/**
 * True if the side to move has run out of time, for a move received at
 * `now` with this timing (see chargeMove).
 */
export function isFlagged(state: ClockState, now: number, timing?: MoveTiming): boolean {
  if (!isClockRunning(state.ply)) return false;
  return chargedTime(state, now, timing) >= moverMs(state);
}

/**
 * Clock after the side to move completes a move received at `now`, charging
 * chargeMove's time, adding the increment and keeping the mover's new lag
 * budget.
 */
export function afterMove(
  state: ClockState,
  now: number,
  incrementMs: number,
  timing?: MoveTiming
): ClockState {
  const mover = activeColor(state.ply);
  const running = isClockRunning(state.ply);
  const charge = chargeMove(state, now, timing);
  const left = Math.max(0, moverMs(state) - charge.chargedMs) + (running ? incrementMs : 0);
  return {
    ...state,
    whiteMs: mover === "white" ? left : state.whiteMs,
    blackMs: mover === "black" ? left : state.blackMs,
    ...(mover === "white" ? { whiteLagBudgetMs: charge.lagBudgetMs } : { blackLagBudgetMs: charge.lagBudgetMs }),
    lastMoveAt: now,
    ply: state.ply + 1,
  };
}

/**
 * Clock after `ms` is added to `color`'s time. The stored time of the side
 * to move is as of lastMoveAt, so adding to it adds to the time they have
 * left now. Capped at MAX_CLOCK_MS (as stored).
 */
export function addTime(state: ClockState, color: PlayerColor, ms: number): ClockState {
  const add = (current: number) => Math.max(current, Math.min(MAX_CLOCK_MS, current + ms));
  return {
    ...state,
    whiteMs: color === "white" ? add(state.whiteMs) : state.whiteMs,
    blackMs: color === "black" ? add(state.blackMs) : state.blackMs,
  };
}

/**
 * When the game must be resolved if nobody moves: a first-move abort, or a
 * flag fall plus MAX_LAG_COMPENSATION_MS for a move still in transit.
 */
export function deadline(state: ClockState): number {
  if (!isClockRunning(state.ply)) return state.lastMoveAt + FIRST_MOVE_TIMEOUT_MS;
  return state.lastMoveAt + moverMs(state) + MAX_LAG_COMPENSATION_MS;
}

/**
 * Longest stretch of a server shutdown (a deploy, a restart) that is kept
 * off the clock. Usually the players are back within seconds; the cap keeps
 * a game whose players never come back from waiting without end.
 */
export const MAX_PAUSE_MS = 60_000;

/**
 * How far a paused game's lastMoveAt and deadline move when it resumes at
 * `now`: the time since the pause, or since the last move if one was played
 * after the pause began (on the server that was shutting down), at most
 * MAX_PAUSE_MS. Nothing when the deadline had already passed when the game
 * was paused: that flag fell before the downtime.
 */
export function resumeShift(
  game: { pausedAt: number; lastMoveAt: number; deadlineAt: number | null },
  now: number
): number {
  if (game.deadlineAt === null || game.deadlineAt <= game.pausedAt) return 0;
  return clamp(now - Math.max(game.pausedAt, game.lastMoveAt), 0, MAX_PAUSE_MS);
}

/**
 * The earliest a paused game that nobody resumes can be decided: its deadline
 * plus the most a resume can add (see resumeShift).
 */
export function pausedDeadline(deadlineAt: number, pausedAt: number): number {
  return deadlineAt > pausedAt ? deadlineAt + MAX_PAUSE_MS : deadlineAt;
}
