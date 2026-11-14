import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { buildBook, checkGame, nextDue, normalizeLine } from "../src/game/repertoire.js";

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

  test("spaced repetition", () => {
    const now = new Date("2026-01-01T00:00:00Z");
    assert.deepEqual(nextDue(now, false, 4), { streak: 0, dueAt: now });
    const first = nextDue(now, true, 0);
    assert.equal(first.streak, 1);
    assert.equal(first.dueAt.getTime() - now.getTime(), 24 * 60 * 60_000);
    assert.equal(nextDue(now, true, 10).dueAt.getTime() - now.getTime(), 60 * 24 * 60 * 60_000);
  });
});
