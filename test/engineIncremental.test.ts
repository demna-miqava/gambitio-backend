import { test } from "node:test";
import assert from "node:assert/strict";
import { Chess } from "chess.js";
import {
  applyMove,
  applyMoveTo,
  appendToPgn,
  loadGame,
  takebackPlies,
  undoMoves,
} from "../src/game/engine.js";
import { PositionCache } from "../src/game/positionCache.js";

/** Small deterministic PRNG so failures reproduce */
function rng(seed: number) {
  return () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 2 ** 32;
  };
}

test("incremental moves produce exactly chess.js's PGN, FEN and outcome", () => {
  for (let seed = 1; seed <= 8; seed++) {
    const random = rng(seed);
    const reference = new Chess();
    const chess = new Chess();
    let pgn = "";
    let ply = 0;
    while (!reference.isGameOver() && ply < 400) {
      const moves = reference.moves({ verbose: true });
      const pick = moves[Math.floor(random() * moves.length)]!;
      reference.move(pick);
      const input = { from: pick.from, to: pick.to, promotion: pick.promotion as "q" | undefined };

      const fast = applyMoveTo(chess, pgn, ply, input);
      assert.ok(fast.ok);
      // A wrong append would stay in the string, so checking every few plies
      // (and at the end) catches it without making the test quadratic
      const last = reference.isGameOver() || ply === 399;
      if (ply < 12 || ply % 25 === 0 || last) {
        assert.equal(fast.pgn, reference.pgn(), `seed ${seed} ply ${ply}`);
        assert.deepEqual(fast, applyMove(pgn, input));
      }
      pgn = fast.pgn;
      ply = fast.ply;
    }
    // The stored PGN loads back to the same position
    assert.equal(loadGame(pgn).fen(), reference.fen());
  }
});

test("an illegal move leaves the cached position unchanged", () => {
  const chess = new Chess();
  const first = applyMoveTo(chess, "", 0, { from: "e2", to: "e4" });
  assert.ok(first.ok);
  const fen = chess.fen();
  const bad = applyMoveTo(chess, first.pgn, first.ply, { from: "e4", to: "e6" });
  assert.equal(bad.ok, false);
  assert.equal(chess.fen(), fen);
});

test("a takeback undoes the requester's move and any reply, never back before ply 2", () => {
  // White to move: white undoes the reply too, black just their own move
  assert.equal(takebackPlies(4, "white"), 2);
  assert.equal(takebackPlies(4, "black"), 1);
  assert.equal(takebackPlies(3, "white"), 1);
  // Would reopen the first-move window, or the requester hasn't moved
  assert.equal(takebackPlies(3, "black"), null);
  assert.equal(takebackPlies(2, "white"), null);
  assert.equal(takebackPlies(2, "black"), null);
  assert.equal(takebackPlies(1, "white"), null);
  assert.equal(takebackPlies(0, "white"), null);
});

test("undoing moves gives the PGN the moves would have written", () => {
  const pgns = [""];
  const chess = new Chess();
  for (const [from, to] of [["e2", "e4"], ["e7", "e5"], ["g1", "f3"], ["b8", "c6"]] as const) {
    const played = applyMoveTo(chess, pgns.at(-1)!, pgns.length - 1, { from, to });
    assert.ok(played.ok);
    pgns.push(played.pgn);
  }
  // Both on a live position and on one loaded from the stored PGN
  for (const position of [chess, loadGame(pgns[4])]) {
    const undone = undoMoves(position, 4, 2);
    assert.deepEqual(undone, { fen: loadGame(pgns[2]).fen(), pgn: pgns[2], ply: 2 });
    // ...and the next move appends to it
    const next = applyMoveTo(position, undone.pgn, undone.ply, { from: "d2", to: "d4" });
    assert.ok(next.ok);
    assert.equal(next.pgn, position.pgn());
  }
});

test("appendToPgn refuses PGN it didn't write", () => {
  assert.equal(appendToPgn("1. e4 e5", 2, "Nf3"), null);
  assert.equal(appendToPgn("something", 0, "e4"), null);
});

test("the position cache only hands back a position matching the stored row", () => {
  const cache = new PositionCache();
  const chess = new Chess();
  const moved = applyMoveTo(chess, "", 0, { from: "e2", to: "e4" });
  assert.ok(moved.ok);
  cache.commit(7, chess, moved.pgn, moved.ply);

  // Matching row: the same instance comes back
  assert.equal(cache.checkout(7, moved.pgn, 1), chess);
  // Checked out: a second checkout rebuilds instead of sharing it
  assert.notEqual(cache.checkout(7, moved.pgn, 1), chess);

  cache.commit(7, chess, moved.pgn, moved.ply);
  // Stale (another instance moved): rebuilt from the stored PGN
  const other = applyMove(moved.pgn, { from: "e7", to: "e5" });
  assert.ok(other.ok);
  const rebuilt = cache.checkout(7, other.pgn, 2);
  assert.notEqual(rebuilt, chess);
  assert.equal(rebuilt.fen(), other.fen);
});

test("a move on a cached position costs far less than replaying a long game", () => {
  const random = rng(42);
  const chess = new Chess();
  let pgn = "";
  let ply = 0;
  // 300 random plies, never picking a move that ends the game
  while (ply < 300) {
    const moves = chess.moves({ verbose: true });
    let r;
    for (let tries = 0; tries < 50; tries++) {
      const pick = moves[Math.floor(random() * moves.length)]!;
      const probe = new Chess(chess.fen());
      probe.move(pick);
      if (probe.isGameOver() && tries < 49) continue;
      r = applyMoveTo(chess, pgn, ply, { from: pick.from, to: pick.to, promotion: pick.promotion as "q" | undefined });
      break;
    }
    if (!r?.ok || r.outcome) break;
    pgn = r.pgn;
    ply = r.ply;
  }
  assert.ok(ply >= 150, `game only reached ply ${ply}`);
  const next = chess.moves({ verbose: true })[0]!;
  const input = { from: next.from, to: next.to, promotion: next.promotion as "q" | undefined };
  const time = (fn: () => void) => {
    const start = process.hrtime.bigint();
    for (let i = 0; i < 20; i++) fn();
    return Number(process.hrtime.bigint() - start) / 20 / 1e6;
  };
  const replay = time(() => applyMove(pgn, input));
  const cached = time(() => applyMoveTo(new Chess(chess.fen()), pgn, ply, input));
  console.log(`ply ${ply}: replay ${replay.toFixed(2)} ms, cached ${cached.toFixed(3)} ms per move`);
  assert.ok(cached * 5 < replay, `cached ${cached.toFixed(2)} ms vs replay ${replay.toFixed(2)} ms`);
});
