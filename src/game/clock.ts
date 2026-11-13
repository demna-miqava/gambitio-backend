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
 * Most network delay a single move is forgiven. A player's clock on their
 * screen starts when the opponent's move reaches them and stops when they
 * move; the server's starts when it receives the opponent's move and stops
 * when this player's move reaches it, so it also counts both trips over the
 * network. With each move the client reports how long the player actually
 * thought, and the server charges that, as long as the difference stays
 * within this much (the claim can't be checked, so a dishonest client gains
 * at most this per move). Also how long the server waits past a flag before
 * ending the game, so a move already on its way still counts.
 */
export const MAX_LAG_COMPENSATION_MS = 1_000;

export interface ClockState {
  whiteMs: number;
  blackMs: number;
  lastMoveAt: number; // epoch ms
  ply: number; // half-moves played so far
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

/**
 * Time the side to move is charged for a move received at `now`: the time
 * the client says the player thought (`thinkMs`), but never less than the
 * server's measure minus MAX_LAG_COMPENSATION_MS, nor more than the server's
 * measure. Without a report, the server's measure.
 */
export function chargedTime(state: ClockState, now: number, thinkMs?: number): number {
  if (!isClockRunning(state.ply)) return 0;
  const elapsed = Math.max(0, now - state.lastMoveAt);
  if (thinkMs === undefined) return elapsed;
  return Math.min(elapsed, Math.max(thinkMs, elapsed - MAX_LAG_COMPENSATION_MS));
}

function moverMs(state: ClockState): number {
  return activeColor(state.ply) === "white" ? state.whiteMs : state.blackMs;
}

/**
 * True if the side to move has run out of time, for a move received at
 * `now` that took `thinkMs` on the player's side (see chargedTime).
 */
export function isFlagged(state: ClockState, now: number, thinkMs?: number): boolean {
  if (!isClockRunning(state.ply)) return false;
  return chargedTime(state, now, thinkMs) >= moverMs(state);
}

/**
 * Clock after the side to move completes a move received at `now`, charging
 * chargedTime and adding the increment.
 */
export function afterMove(
  state: ClockState,
  now: number,
  incrementMs: number,
  thinkMs?: number
): ClockState {
  const mover = activeColor(state.ply);
  const running = isClockRunning(state.ply);
  const left = Math.max(0, moverMs(state) - chargedTime(state, now, thinkMs)) + (running ? incrementMs : 0);
  return {
    whiteMs: mover === "white" ? left : state.whiteMs,
    blackMs: mover === "black" ? left : state.blackMs,
    lastMoveAt: now,
    ply: state.ply + 1,
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
