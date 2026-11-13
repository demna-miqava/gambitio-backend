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

/** True if the side to move has run out of time at `now`. */
export function isFlagged(state: ClockState, now: number): boolean {
  if (!isClockRunning(state.ply)) return false;
  const left = remainingAt(state, now);
  return (activeColor(state.ply) === "white" ? left.whiteMs : left.blackMs) <= 0;
}

/** Clock after the side to move completes a move at `now`, adding the increment. */
export function afterMove(state: ClockState, now: number, incrementMs: number): ClockState {
  const mover = activeColor(state.ply);
  const left = remainingAt(state, now);
  const bonus = isClockRunning(state.ply) ? incrementMs : 0;
  return {
    whiteMs: mover === "white" ? left.whiteMs + bonus : left.whiteMs,
    blackMs: mover === "black" ? left.blackMs + bonus : left.blackMs,
    lastMoveAt: now,
    ply: state.ply + 1,
  };
}

/** When the game must be resolved if nobody moves: a flag fall, or a first-move abort. */
export function deadline(state: ClockState): number {
  if (!isClockRunning(state.ply)) return state.lastMoveAt + FIRST_MOVE_TIMEOUT_MS;
  const left = activeColor(state.ply) === "white" ? state.whiteMs : state.blackMs;
  return state.lastMoveAt + left;
}
