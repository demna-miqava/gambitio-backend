import { test } from "node:test";
import assert from "node:assert/strict";
import {
  arenaPoints,
  compareStanding,
  lastPairingMs,
  nextStreak,
  outcomeFor,
  pairArena,
  performance,
  scoreGame,
  SHEET_MAX,
  type WaitingPlayer,
} from "../src/game/arena.js";

const player = (userId: number, over: Partial<WaitingPlayer> = {}): WaitingPlayer => ({
  userId,
  score: 0,
  performance: 0,
  whites: 0,
  games: 0,
  lastOpponentId: null,
  waitingSince: 1_000,
  ...over,
});
const ids = (pairs: { whiteId: number; blackId: number }[]) =>
  pairs.map((p) => [p.whiteId, p.blackId].sort((a, b) => a - b));
const heads = () => true;

test("a result is a win, draw or loss for each side, and nothing when aborted", () => {
  assert.equal(outcomeFor("white_win", "white"), "win");
  assert.equal(outcomeFor("white_win", "black"), "loss");
  assert.equal(outcomeFor("black_win", "black"), "win");
  assert.equal(outcomeFor("draw", "white"), "draw");
  assert.equal(outcomeFor("aborted", "white"), null);
});

test("points are 2, 1, 0, doubled on a streak of two wins", () => {
  assert.deepEqual([arenaPoints("win", 0), arenaPoints("draw", 0), arenaPoints("loss", 0)], [2, 1, 0]);
  assert.equal(arenaPoints("win", 1), 2);
  assert.deepEqual([arenaPoints("win", 2), arenaPoints("draw", 2), arenaPoints("loss", 2)], [4, 2, 0]);
  assert.equal(arenaPoints("win", 7), 4);
  // A win extends the streak; anything else ends it
  assert.equal(nextStreak("win", 2), 3);
  assert.equal(nextStreak("draw", 5), 0);
  assert.equal(nextStreak("loss", 1), 0);
});

test("a run of games adds up as the standings show it", () => {
  let row = { score: 0, streak: 0, games: 0, wins: 0, draws: 0, opponentRatingSum: 0, sheet: "" };
  // win, win, win (on a streak: 4), draw (still doubled: 2), win (streak gone: 2), loss
  for (const outcome of ["win", "win", "win", "draw", "win", "loss"] as const) {
    row = scoreGame(row, outcome, 1500);
  }
  assert.equal(row.sheet, "224220");
  assert.equal(row.score, 12);
  assert.equal(row.streak, 0);
  assert.deepEqual([row.games, row.wins, row.draws], [6, 4, 1]);
  assert.equal(row.opponentRatingSum, 9000);
});

test("the score sheet keeps only its newest digits", () => {
  const long = scoreGame({ score: 0, streak: 0, games: 0, wins: 0, draws: 0, opponentRatingSum: 0, sheet: "1".repeat(SHEET_MAX) }, "win", 1500);
  assert.equal(long.sheet.length, SHEET_MAX);
  assert.ok(long.sheet.endsWith("12"));
});

test("performance is the opponents' average, moved by the results", () => {
  assert.equal(performance({ games: 0, wins: 0, draws: 0, opponentRatingSum: 0 }), 0);
  assert.equal(performance({ games: 2, wins: 1, draws: 0, opponentRatingSum: 3000 }), 1500);
  assert.equal(performance({ games: 2, wins: 2, draws: 0, opponentRatingSum: 3000 }), 1900);
  assert.equal(performance({ games: 4, wins: 0, draws: 2, opponentRatingSum: 6000 }), 1300);
});

test("standings order: points, then performance, then the lower id", () => {
  const rows = [
    { userId: 3, score: 4, performance: 1500 },
    { userId: 1, score: 6, performance: 1200 },
    { userId: 2, score: 4, performance: 1600 },
    { userId: 4, score: 4, performance: 1500 },
  ];
  assert.deepEqual(rows.sort(compareStanding).map((r) => r.userId), [1, 2, 3, 4]);
});

test("neighbours in the standings are paired", () => {
  const waiting = [player(1, { score: 0 }), player(2, { score: 8 }), player(3, { score: 2 }), player(4, { score: 6 })];
  assert.deepEqual(ids(pairArena(waiting, { coin: heads })), [
    [2, 4],
    [1, 3],
  ]);
  assert.deepEqual(pairArena([], { coin: heads }), []);
  assert.deepEqual(pairArena([player(1)], { coin: heads }), []);
});

test("nobody is paired twice, whatever the field", () => {
  for (let n = 0; n <= 25; n++) {
    const waiting = Array.from({ length: n }, (_, i) =>
      player(i + 1, { score: (i * 7) % 5, lastOpponentId: ((i * 3) % n) + 1, waitingSince: 1_000 + ((i * 11) % 7) })
    );
    const pairs = pairArena(waiting);
    const seen = pairs.flatMap((p) => [p.whiteId, p.blackId]);
    assert.equal(new Set(seen).size, seen.length, `${n} players`);
    assert.equal(pairs.length, Math.floor(n / 2), `${n} players`);
    for (const p of pairs) assert.notEqual(p.whiteId, p.blackId);
  }
});

test("two who just played are kept apart while there is someone else", () => {
  const waiting = [
    player(1, { score: 6, lastOpponentId: 2 }),
    player(2, { score: 6, lastOpponentId: 1 }),
    player(3, { score: 2 }),
    player(4, { score: 0 }),
  ];
  assert.deepEqual(ids(pairArena(waiting, { coin: heads })), [
    [1, 3],
    [2, 4],
  ]);
  // Only the two of them: they play again rather than wait for nobody
  assert.deepEqual(ids(pairArena(waiting.slice(0, 2), { coin: heads })), [[1, 2]]);
});

test("players with a block between them never meet", () => {
  const blocked = (a: number, b: number) => (a === 1 && b === 2) || (a === 2 && b === 1);
  const four = [player(1, { score: 6 }), player(2, { score: 5 }), player(3, { score: 1 }), player(4)];
  assert.deepEqual(ids(pairArena(four, { blocked, coin: heads })), [
    [1, 3],
    [2, 4],
  ]);
  // Alone together: both sit out
  assert.deepEqual(pairArena(four.slice(0, 2), { blocked, coin: heads }), []);
});

test("with an odd number, whoever has waited longest is not the one left out", () => {
  const waiting = [
    player(1, { score: 9, waitingSince: 5_000 }),
    player(2, { score: 6, waitingSince: 5_000 }),
    // Bottom of the standings, and already sat out the last pass
    player(3, { score: 0, waitingSince: 1_000 }),
  ];
  const paired = pairArena(waiting, { coin: heads }).flatMap((p) => [p.whiteId, p.blackId]);
  assert.equal(paired.length, 2);
  assert.ok(paired.includes(3));
});

test("white goes to whoever has had it less", () => {
  const owed = player(1, { whites: 0, games: 2 });
  const hadIt = player(2, { whites: 2, games: 2 });
  assert.deepEqual(pairArena([owed, hadIt]), [{ whiteId: 1, blackId: 2 }]);
  assert.deepEqual(pairArena([hadIt, owed]), [{ whiteId: 1, blackId: 2 }]);
  // Even: the coin decides
  const a = player(1);
  const b = player(2);
  assert.deepEqual(pairArena([a, b], { coin: () => true }), [{ whiteId: 1, blackId: 2 }]);
  assert.deepEqual(pairArena([a, b], { coin: () => false }), [{ whiteId: 2, blackId: 1 }]);
});

test("the last games start a clock's length before the end, a minute at most", () => {
  assert.equal(lastPairingMs(30), 30_000);
  assert.equal(lastPairingMs(60), 60_000);
  assert.equal(lastPairingMs(600), 60_000);
});
