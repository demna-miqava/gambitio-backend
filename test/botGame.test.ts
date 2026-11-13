import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { MAX_BOT_GAME_PGN_LENGTH, replayBotGame } from "../src/game/botGame.js";
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
