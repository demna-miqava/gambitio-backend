import { test } from "node:test";
import assert from "node:assert/strict";
import {
  afterMove,
  chargeMove,
  deadline,
  INITIAL_LAG_BUDGET_MS,
  isFlagged,
  LAG_BUDGET_CAP_MS,
  LAG_BUDGET_REFILL_MS,
  LAG_SLACK_MS,
  MAX_LAG_COMPENSATION_MS,
  MAX_PAUSE_MS,
  pausedDeadline,
  resumeShift,
  type ClockState,
} from "../src/game/clock.js";

/**
 * Plays `moves` moves for white (black answers instantly and honestly), each
 * reaching the server `elapsed` ms after black's move, and returns white's
 * clock and the time forgiven on each move.
 */
function playWhite(
  moves: number,
  elapsed: number,
  timing: { thinkMs?: number; measuredRttMs?: number },
  start: Partial<ClockState> = {}
) {
  let state: ClockState = { whiteMs: 600_000, blackMs: 600_000, lastMoveAt: 0, ply: 2, ...start };
  const forgiven: number[] = [];
  for (let i = 0; i < moves; i++) {
    const now = state.lastMoveAt + elapsed;
    forgiven.push(chargeMove(state, now, timing).forgivenMs);
    state = afterMove(state, now, 0, timing);
    // Black's reply, at the same instant, charged nothing
    state = afterMove(state, now, 0, { thinkMs: 0, measuredRttMs: 0 });
  }
  return { state, forgiven };
}

test("an honest player's measured delay is forgiven in full, every move", () => {
  // 200ms of thinking, a 300ms round trip the server measured too
  const { state, forgiven } = playWhite(30, 500, { thinkMs: 200, measuredRttMs: 300 });
  assert.ok(forgiven.every((ms) => ms === 300));
  assert.equal(state.whiteMs, 600_000 - 30 * 200, "charged only their thinking");
  assert.equal(state.whiteLagBudgetMs, LAG_BUDGET_CAP_MS, "the budget only grew, up to its cap");
});

test("a client that always reports thinkMs 0 is drained to slack + refill per move", () => {
  // Really 2s of thinking per move, a 30ms round trip measured
  const { forgiven } = playWhite(20, 2_000, { thinkMs: 0, measuredRttMs: 30 });
  // The first move spends the starting budget...
  assert.equal(forgiven[0], 30 + LAG_SLACK_MS + INITIAL_LAG_BUDGET_MS);
  // ...after that only the measured round trip, the slack and one refill
  for (const ms of forgiven.slice(1)) assert.equal(ms, 30 + LAG_SLACK_MS + LAG_BUDGET_REFILL_MS);
  assert.ok(forgiven.every((ms) => ms < MAX_LAG_COMPENSATION_MS));
});

test("without a measurement only the budget covers claimed delay", () => {
  const first = chargeMove({ whiteMs: 60_000, blackMs: 60_000, lastMoveAt: 0, ply: 2 }, 1_000, { thinkMs: 700 });
  assert.equal(first.freeMs, 0);
  assert.equal(first.forgivenMs, 300, "a claim within the budget is believed");
  assert.equal(first.lagBudgetMs, INITIAL_LAG_BUDGET_MS - 300 + LAG_BUDGET_REFILL_MS);

  // A steady 300ms claim drains it to one refill per move
  const { forgiven } = playWhite(20, 1_000, { thinkMs: 700 });
  assert.deepEqual(forgiven.slice(-3), [LAG_BUDGET_REFILL_MS, LAG_BUDGET_REFILL_MS, LAG_BUDGET_REFILL_MS]);
});

test("the budget refills per move up to its cap, and stored values are kept in range", () => {
  const { state } = playWhite(100, 1_000, { thinkMs: 1_000 });
  assert.equal(state.whiteLagBudgetMs, LAG_BUDGET_CAP_MS);
  const base = { whiteMs: 60_000, blackMs: 60_000, lastMoveAt: 0, ply: 2 };
  assert.equal(chargeMove({ ...base, whiteLagBudgetMs: 50_000 }, 0, { thinkMs: 0 }).lagBudgetMs, LAG_BUDGET_CAP_MS);
  assert.equal(chargeMove({ ...base, whiteLagBudgetMs: -40 }, 3_000, { thinkMs: 0 }).forgivenMs, 0);
  // Without a report nothing is forgiven, and the budget doesn't change
  const unreported = chargeMove({ ...base, whiteLagBudgetMs: 120 }, 3_000);
  assert.deepEqual([unreported.chargedMs, unreported.lagBudgetMs], [3_000, 120]);
  // Before the clock runs, nothing is charged or spent
  const opening = chargeMove({ ...base, ply: 1, blackLagBudgetMs: 120 }, 3_000, { thinkMs: 0 });
  assert.deepEqual([opening.chargedMs, opening.lagBudgetMs], [0, 120]);
});

test("flag decisions use the same rule", () => {
  // White to move with 100ms left; the move arrives 400ms later having
  // taken 50ms of thought
  const state: ClockState = { whiteMs: 100, blackMs: 60_000, lastMoveAt: 0, ply: 30, whiteLagBudgetMs: 0 };
  assert.equal(isFlagged(state, 400, { thinkMs: 50, measuredRttMs: 300 }), false, "measured delay saves it");
  assert.equal(isFlagged(state, 400, { thinkMs: 50 }), true, "an unmeasured claim with no budget doesn't");
  assert.equal(isFlagged({ ...state, whiteLagBudgetMs: 400 }, 400, { thinkMs: 50 }), false, "the budget can");
  assert.equal(isFlagged(state, 400), true, "nor does a move without a report");
  // A claim beyond everything: charged the excess
  assert.equal(chargeMove(state, 2_000, { thinkMs: 0, measuredRttMs: 1_000 }).chargedMs, 1_000);
});

test("a move stored after it arrived starts the opponent's clock when stored, charging the mover to arrival", () => {
  const state: ClockState = { whiteMs: 10_000, blackMs: 500, lastMoveAt: 0, ply: 30 };
  // Arrived at 1s, stored at 3s (it waited behind the mover's other messages)
  const next = afterMove(state, 1_000, 0, undefined, 3_000);
  assert.equal(next.whiteMs, 9_000, "the mover pays up to arrival");
  assert.equal(next.blackMs, 500);
  assert.equal(next.lastMoveAt, 3_000, "the opponent's clock starts once the move is stored");
  assert.equal(deadline(next), 3_000 + 500 + MAX_LAG_COMPENSATION_MS, "so they aren't flagged by the wait");
  assert.equal(afterMove(state, 1_000, 0).lastMoveAt, 1_000, "at arrival when left out");
  assert.equal(afterMove(state, 1_000, 0, undefined, 500).lastMoveAt, 1_000, "never before arrival");
});

test("a resumed game shifts by the pause, capped, and not at all after a fallen flag", () => {
  const paused = { pausedAt: 10_000, lastMoveAt: 4_000, deadlineAt: 30_000 };
  assert.equal(resumeShift(paused, 25_000), 15_000);
  assert.equal(resumeShift(paused, 10_000 + 5 * MAX_PAUSE_MS), MAX_PAUSE_MS);
  // A move played after the pause began (on the server shutting down)
  assert.equal(resumeShift({ ...paused, lastMoveAt: 12_000 }, 25_000), 13_000);
  // The flag fell before the pause: that decides the game
  assert.equal(resumeShift({ ...paused, deadlineAt: 9_000 }, 25_000), 0);
  assert.equal(resumeShift({ ...paused, deadlineAt: null }, 25_000), 0);
  assert.equal(resumeShift(paused, 5_000), 0, "never backwards");

  assert.equal(pausedDeadline(30_000, 10_000), 30_000 + MAX_PAUSE_MS);
  assert.equal(pausedDeadline(9_000, 10_000), 9_000);
});
