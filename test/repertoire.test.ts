import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { Chess } from "chess.js";
import { buildBook, checkGame, nextDue, normalizeLine, pgnSans, positionKey } from "../src/game/repertoire.js";
import { appendToPgn, undoMoves } from "../src/game/engine.js";
import { replayBotGame } from "../src/game/botGame.js";

/** A random legal game of up to `plies` half-moves (deterministic per seed). */
function randomGame(seed: number, plies: number): Chess {
  let x = seed;
  const random = () => ((x = (x * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  const chess = new Chess();
  for (let i = 0; i < plies && !chess.isGameOver(); i++) {
    const moves = chess.moves();
    chess.move(moves[Math.floor(random() * moves.length)]!);
  }
  return chess;
}

const line = (id: number, moves: string) => ({ id, name: `Line ${id}`, moves: moves.split(" ") });

describe("repertoire", () => {
  test("normalises SAN and rejects illegal lines", () => {
    assert.deepEqual(normalizeLine(["e4", "e5", "Ng1f3"]), ["e4", "e5", "Nf3"]);
    assert.throws(() => normalizeLine(["e4", "e4"]), /Move 2/);
    assert.throws(() => normalizeLine([]), /no moves/);
  });

  test("finds where the player left their preparation", () => {
    const book = buildBook([line(1, "e4 e5 Nf3 Nc6 Bb5"), line(2, "e4 c5 Nf3")]);
    const game = "e4 e5 Bc4 Nf6".split(" ");
    const check = checkGame(book, game, "white");
    assert.equal(check.status, "you_deviated");
    assert.equal(check.pliesInBook, 2);
    assert.equal(check.divergence?.played, "Bc4");
    assert.deepEqual(check.divergence?.expected, ["Nf3"]);
    assert.equal(check.divergence?.moveNumber, 2);
    assert.equal(check.divergence?.color, "white");
  });

  test("an opponent's unexpected reply is theirs", () => {
    const book = buildBook([line(1, "e4 e5 Nf3"), line(2, "e4 c5 Nf3")]);
    const check = checkGame(book, "e4 e6 d4".split(" "), "white");
    assert.equal(check.status, "opponent_deviated");
    assert.deepEqual(check.divergence?.expected.sort(), ["c5", "e5"]);
  });

  test("running past the end of a line is following it", () => {
    const book = buildBook([line(1, "e4 e5 Nf3")]);
    assert.equal(checkGame(book, "e4 e5 Nf3 Nc6 Bb5".split(" "), "white").status, "followed");
    // Prepared against 1.e4 only, as black: 1.d4 is the opponent's surprise
    assert.equal(checkGame(book, "d4 d5".split(" "), "black").status, "opponent_deviated");
    assert.equal(checkGame(buildBook([]), "d4 d5".split(" "), "black").status, "not_covered");
  });

  test("transpositions reach the same book position", () => {
    // Line 2 reaches line 1's position by another move order
    const book = buildBook([line(1, "d4 Nf6 c4 e6 Nc3"), line(2, "c4 e6 d4 Nf6")]);
    const check = checkGame(book, "c4 e6 d4 Nf6 Nf3".split(" "), "white");
    assert.equal(check.status, "you_deviated");
    assert.deepEqual(check.divergence?.expected, ["Nc3"]);
  });

  test("reads the moves of PGNs as the server stores them", () => {
    for (let seed = 1; seed <= 40; seed++) {
      const game = randomGame(seed, 30 + seed * 7);
      const sans = game.history();
      // Built move by move, as live games are (appendToPgn)...
      let pgn = "";
      sans.forEach((san, ply) => {
        pgn = appendToPgn(pgn, ply, san)!;
      });
      assert.equal(pgn, game.pgn());
      assert.deepEqual(pgnSans(pgn), sans, `seed ${seed}`);
      // ...or after a takeback (chess.js's own pgn())
      const replay = new Chess();
      for (const san of sans) replay.move(san);
      const taken = undoMoves(replay, sans.length, Math.min(2, sans.length));
      assert.deepEqual(pgnSans(taken.pgn), sans.slice(0, sans.length - Math.min(2, sans.length)));
      // At most `max` moves
      assert.deepEqual(pgnSans(pgn, 5), sans.slice(0, 5));
    }
    // Promotions, castling, checks and mates
    const mate = new Chess();
    for (const san of ["f3", "e5", "g4", "Qh4#"]) mate.move(san);
    assert.deepEqual(pgnSans(mate.pgn()), ["f3", "e5", "g4", "Qh4#"]);
    assert.deepEqual(pgnSans(`[Event "?"]\n\n1. e4 d5 2. exd5 c6 3. dxc6 Nf6 4. cxb7 Nc6 5. bxa8=Q O-O-O *`).slice(-2), [
      "bxa8=Q",
      "O-O-O",
    ]);
    // Bot games are stored as chess.js writes them after a replay
    const bot = replayBotGame("1. e4 e5 2. Bc4 Nc6 3. Qh5 Nf6 4. Qxf7#", "white", "checkmate");
    assert.deepEqual(pgnSans(bot.pgn), ["e4", "e5", "Bc4", "Nc6", "Qh5", "Nf6", "Qxf7#"]);
  });

  test("PGN extras are skipped, and set-up positions have no moves", () => {
    const pgn = `[Event "Casual"]
[Site "?"]
[Result "1-0"]

1. e4 {best by test} e5 2.Nf3 $1 Nc6 (2... d6 3. d4 (3. Bc4) exd4) 3. Bb5!? a6;  Morphy
4. Ba4 1-0`;
    assert.deepEqual(pgnSans(pgn), ["e4", "e5", "Nf3", "Nc6", "Bb5", "a6", "Ba4"]);
    assert.deepEqual(pgnSans(`[SetUp "1"]\n[FEN "8/8/8/8/8/8/8/K6k w - - 0 1"]\n\n1. Kb1 *`), []);
    assert.deepEqual(pgnSans(""), []);
    assert.deepEqual(pgnSans("1... e5 2. Nf3 *"), ["e5", "Nf3"]);
  });

  test("lines that share their start build the same book as playing each one out", () => {
    const lines = [
      line(1, "e4 e5 Nf3 Nc6 Bb5 a6 Ba4"),
      line(2, "e4 e5 Nf3 Nc6 Bc4 Bc5"),
      line(3, "e4 e5 Nf3 Nf6"),
      line(4, "e4 c5 Nf3 d6 d4 cxd4 Nxd4"),
      line(5, "d4 Nf6 c4 e6 Nc3"),
      line(6, "c4 e6 d4 Nf6"),
      line(7, "e4 e5 Nf3 Nc6 Bb5 Nf6"),
    ];
    // The straightforward way: every line played from the start
    const expected = new Map<string, Map<string, number[]>>();
    for (const { id, moves } of lines) {
      const chess = new Chess();
      for (const san of moves) {
        const key = positionKey(chess.fen());
        const played = chess.move(san).san;
        const at = expected.get(key) ?? new Map<string, number[]>();
        expected.set(key, at.set(played, [...(at.get(played) ?? []), id]));
      }
    }
    const book = buildBook(lines);
    const actual = new Map([...book].map(([key, moves]) => [key, new Map([...moves].map(([san, e]) => [san, e.lineIds]))]));
    assert.deepEqual(actual, expected);
  });

  test("spaced repetition", () => {
    const now = new Date("2026-01-01T00:00:00Z");
    assert.deepEqual(nextDue(now, false, 4), { streak: 0, dueAt: now });
    const first = nextDue(now, true, 0);
    assert.equal(first.streak, 1);
    assert.equal(first.dueAt.getTime() - now.getTime(), 24 * 60 * 60_000);
    assert.equal(nextDue(now, true, 10).dueAt.getTime() - now.getTime(), 60 * 24 * 60 * 60_000);
  });
});
