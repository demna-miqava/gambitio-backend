import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Chess } from "chess.js";
import { MAX_BOT_GAME_PGN_LENGTH, readPgn, replayBotGame } from "../src/game/botGame.js";
import { BOTS, getBotById } from "../src/game/bots.js";
import { AppError } from "../src/errors/AppError.js";

const FOOLS_MATE = `[Event "Game against Casual Carl"]
[White "whitey"]
[Black "Casual Carl"]
[Result "0-1"]

1. f3 e5 2. g4 Qh4# 0-1`;

const rejects = (fn: () => unknown, message: RegExp) =>
  assert.throws(fn, (err: unknown) => err instanceof AppError && err.statusCode === 400 && message.test(err.message));

test("derives checkmate from the position, whatever the client claims", () => {
  const game = replayBotGame(FOOLS_MATE, "white", "resignation");
  assert.deepEqual(game.outcome, { result: "black_win", reason: "checkmate" });
  assert.equal(game.numMoves, 4);
  // Rebuilt the way live games store theirs; the client's headers are dropped
  assert.match(game.pgn, /\n1\. f3 e5 2\. g4 Qh4# \*$/);
  assert.doesNotMatch(game.pgn, /whitey|Casual Carl/);
  assert.match(game.fen, /^rnb1kbnr\/pppp1ppp\/8\/4p3\/6Pq\/5P2\/PPPPP2P\/RNBQKBNR w KQkq/);
});

test("a resignation is a loss for the player, whichever side they played", () => {
  assert.deepEqual(replayBotGame("1. e4 e5", "white", "resignation").outcome, {
    result: "black_win",
    reason: "resignation",
  });
  assert.deepEqual(replayBotGame("1. e4 e5", "black", "resignation").outcome, {
    result: "white_win",
    reason: "resignation",
  });
});

test("detects draws from the position", () => {
  const repetition = replayBotGame("1. Nf3 Nf6 2. Ng1 Ng8 3. Nf3 Nf6 4. Ng1 Ng8", "white", "threefold_repetition");
  assert.deepEqual(repetition.outcome, { result: "draw", reason: "threefold_repetition" });
});

test("rejects a game that isn't over unless the player resigned", () => {
  rejects(() => replayBotGame("1. e4 e5", "white", "checkmate"), /isn't over/);
});

test("rejects illegal, empty, custom-position and over-long games", () => {
  rejects(() => replayBotGame("1. e4 e4", "white", "resignation"), /legal/);
  rejects(() => replayBotGame("garbage", "white", "resignation"), /legal|no moves/);
  rejects(() => replayBotGame('[Result "*"]\n\n*', "white", "resignation"), /no moves/);
  rejects(
    () =>
      replayBotGame(
        '[SetUp "1"]\n[FEN "6k1/5ppp/8/8/8/8/5PPP/3R2K1 w - - 0 1"]\n\n1. Rd8#',
        "white",
        "checkmate"
      ),
    /standard position/
  );
  rejects(() => replayBotGame("1. e4 ".repeat(MAX_BOT_GAME_PGN_LENGTH), "white", "resignation"), /too long/);
});

test("rejects moves played after the game ended", () => {
  // Black is mated after 2... Qh4#, so 3. a3 can't follow
  rejects(() => replayBotGame("1. f3 e5 2. g4 Qh4# 3. a3", "white", "resignation"), /after the game was over|legal/);
});

test("the stored PGN is exactly what chess.js would write, from one replay", () => {
  // A longer game with captures, checks, castling and a promotion
  const moves = [
    "e4", "d5", "exd5", "Qxd5", "Nc3", "Qa5", "d4", "Nf6", "Nf3", "Bf5", "Bc4", "e6", "O-O", "c6",
    "Re1", "Bb4", "a3", "Bxc3", "bxc3", "Qxc3", "Bd2", "Qc2", "Qxc2", "Bxc2", "Rec1", "Be4",
  ];
  const reference = new Chess();
  for (const san of moves) reference.move(san);
  // What the browser sends: headers, then the moves
  reference.setHeader("Event", "Game against Club Clara");
  reference.setHeader("White", "whitey");
  reference.setHeader("Black", "Club Clara");
  const game = replayBotGame(reference.pgn(), "white", "resignation");
  const plain = new Chess();
  for (const san of moves) plain.move(san);
  assert.equal(game.pgn, plain.pgn());
  assert.equal(game.fen, plain.fen());
  assert.equal(game.numMoves, moves.length);
});

test("the PGN reader skips what loadPgn skips", () => {
  const { headers, sans } = readPgn(
    '[Event "A \\"quoted\\" name"]\n[White "x"]\n\n' +
      "1. e4 {a comment} e5 $1 (1... c5 2. Nf3 (2. c3)) 2.Nf3 ; to the end\nNc6 3. Bb5!? *"
  );
  assert.equal(headers.get("Event"), 'A "quoted" name');
  assert.deepEqual(sans, ["e4", "e5", "Nf3", "Nc6", "Bb5!?"]);
  // Annotations and long algebraic play like loadPgn plays them
  assert.equal(replayBotGame("1. e4! e5 2. g1f3", "white", "resignation").pgn.endsWith("1. e4 e5 2. Nf3 *"), true);
});

test("the PGN reader refuses broken text", () => {
  rejects(() => replayBotGame("1. e4 {open comment", "white", "resignation"), /legal/);
  rejects(() => replayBotGame("1. e4 (1. d4", "white", "resignation"), /legal/);
  rejects(() => replayBotGame("1. e4 ) e5", "white", "resignation"), /legal/);
  rejects(() => replayBotGame('[Event "unclosed\n\n1. e4', "white", "resignation"), /legal/);
  rejects(() => replayBotGame("1. e4 e5 1-0 2. Nf3", "white", "resignation"), /after the game was over/);
});

test("the size limit fits a very long game with room to spare", () => {
  // 300 full moves of knights shuffling with pawn moves in between to dodge
  // repetition isn't easy to build, so measure the text a long game takes:
  // move numbers up to 300 and typical endgame moves
  const movetext = Array.from({ length: 300 }, (_, i) => `${i + 1}. Kf2+ Kxg7`).join(" ");
  const headers =
    '[Event "Game against Grandmaster Greta"]\n[Site "Gambitio"]\n[Date "2026.11.18"]\n' +
    '[White "a_rather_long_username"]\n[Black "Grandmaster Greta"]\n[Result "1/2-1/2"]\n\n';
  assert.ok((headers + movetext + " 1/2-1/2").length < MAX_BOT_GAME_PGN_LENGTH * 0.75);
});

test("the bot list matches the frontend's", () => {
  const frontend = readFileSync(
    new URL("../../gambitio-frontend/src/features/play-bots/constants/bots.ts", import.meta.url),
    "utf8"
  );
  for (const bot of BOTS) {
    const entry = new RegExp(`id: "${bot.id}",\\s*name: "${bot.name}",\\s*rating: ${bot.rating},`);
    assert.match(frontend, entry, `${bot.id} differs from the frontend list`);
  }
  const frontendIds = [...frontend.matchAll(/id: "([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(frontendIds, BOTS.map((b) => b.id));
  assert.equal(getBotById("casual-bot")?.rating, 600);
  assert.equal(getBotById("nope"), undefined);
});
