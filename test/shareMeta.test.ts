import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  describeSharedGame,
  parseSharedGame,
  shareTokenFromPath,
  withShareMeta,
  type SharedGame,
} from "../worker/shareMeta.js";
import { newShareToken, SHARE_TOKEN_PATTERN } from "../src/utils/shareToken.js";

const game: SharedGame = {
  time: 180,
  increment: 2,
  type: "blitz",
  result: "white_win",
  endReason: "checkmate",
  numMoves: 67,
  botId: null,
  whitePlayer: { username: "alice", rating: 1512 },
  blackPlayer: { username: "bob", rating: 1498 },
};

test("share tokens are 14 letters and digits, and don't repeat", () => {
  const tokens = new Set(Array.from({ length: 2_000 }, newShareToken));
  assert.equal(tokens.size, 2_000);
  for (const token of tokens) assert.match(token, SHARE_TOKEN_PATTERN);
});

test("the Worker recognises exactly the addresses of share pages", () => {
  const token = newShareToken();
  assert.equal(shareTokenFromPath(`/share/${token}`), token);
  assert.equal(shareTokenFromPath(`/share/${token}/`), token);
  for (const path of [
    "/share",
    "/share/",
    `/share/${token}/extra`,
    `/share/${token.slice(1)}`,
    `/share/${token}x`,
    `/share/${token.slice(0, 13)}-`,
    `/shared/${token}`,
    `/api/share/${token}`,
    "/share/../api/users",
  ]) {
    assert.equal(shareTokenFromPath(path), null, path);
  }
});

test("a shared game is described by who played and how it ended", () => {
  assert.deepEqual(describeSharedGame(game), {
    title: "alice (1512) vs bob (1498) · 1-0",
    description: "alice won by checkmate in 34 moves · Blitz 3+2 · Replay the game on Gambitio",
  });
  assert.equal(
    describeSharedGame({ ...game, result: "draw", endReason: "threefold_repetition", numMoves: 80, time: 600, increment: 0, type: "rapid" })
      .description,
    "Draw by repetition in 40 moves · Rapid 10+0 · Replay the game on Gambitio"
  );
  assert.equal(
    describeSharedGame({ ...game, result: "black_win", endReason: "timeout", numMoves: 2, time: 30, increment: 0, type: "bullet" })
      .description,
    "bob won on time in 1 move · Bullet 0.5+0 · Replay the game on Gambitio"
  );
  // A bot game has no clock; an end reason the Worker doesn't know is left out
  const bot = describeSharedGame({ ...game, time: null, type: null, botId: "casual-bot", endReason: "something_new" });
  assert.equal(bot.description, "alice won in 34 moves · Game against a bot · Replay the game on Gambitio");
  assert.equal(describeSharedGame({ ...game, result: null }).title, "alice (1512) vs bob (1498)");
});

test("only a response that looks like a game is used", () => {
  assert.deepEqual(parseSharedGame({ ...game, pgn: "1. e4", id: 7 }), game);
  for (const body of [
    null,
    "game",
    {},
    { error: "This game isn't shared", code: "SHARED_GAME_NOT_FOUND" },
    { ...game, whitePlayer: null },
    { ...game, blackPlayer: { username: "", rating: 1 } },
    { ...game, blackPlayer: { username: "x".repeat(101), rating: 1 } },
    { ...game, numMoves: "67" },
  ]) {
    assert.equal(parseSharedGame(body), null, JSON.stringify(body));
  }
});

test("the game is written into the real index.html's head", async () => {
  const html = await readFile(new URL("../../gambitio-frontend/index.html", import.meta.url), "utf8");
  const out = withShareMeta(html, {
    url: "https://gambitio.example/share/abc",
    image: "https://gambitio.example/logo-mark.png",
    meta: describeSharedGame(game),
  });
  assert.ok(out.includes("<title>alice (1512) vs bob (1498) · 1-0 · Gambitio</title>"));
  assert.ok(out.includes('<meta property="og:title" content="alice (1512) vs bob (1498) · 1-0" />'));
  assert.ok(out.includes('<meta property="og:url" content="https://gambitio.example/share/abc" />'));
  assert.ok(out.includes('<meta property="og:image" content="https://gambitio.example/logo-mark.png" />'));
  assert.ok(out.includes('<meta name="robots" content="noindex" />'));
  // The site's own description is replaced, not doubled
  assert.equal(out.match(/<meta\s+name="description"/g)?.length, 1);
  assert.ok(!out.includes("Play chess online with friends on Gambitio"));
  // Everything else is as it was: the tags went in just before </head>
  assert.ok(out.includes('<script src="/theme-init.js"></script>'));
  assert.ok(out.includes('<div id="root"></div>'));
  assert.ok(out.indexOf("og:title") < out.indexOf("</head>"));
});

test("a share page without a game is still kept out of search results", async () => {
  const html = "<html><head><title>Gambitio</title></head><body></body></html>";
  const out = withShareMeta(html, { url: "https://x/share/abc", image: "https://x/logo.png", meta: null });
  assert.equal(
    out,
    '<html><head><title>Gambitio</title><meta name="robots" content="noindex" />\n  </head><body></body></html>'
  );
  // A page without a head is left alone
  assert.equal(withShareMeta("<p>hi</p>", { url: "u", image: "i", meta: null }), "<p>hi</p>");
});

test("usernames can't break out of the tags they are written into", () => {
  const hostile = describeSharedGame({
    ...game,
    whitePlayer: { username: `"><script>alert(1)</script>`, rating: 1 },
    blackPlayer: { username: "$&</title>$1'", rating: 2 },
  });
  const out = withShareMeta("<head><title>Gambitio</title></head>", { url: 'https://x/"', image: "i", meta: hostile });
  assert.ok(!out.includes("<script>"));
  assert.ok(!out.includes('content=""'));
  assert.equal(out.match(/<\/title>/g)?.length, 1);
  assert.ok(out.includes("&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;"));
  assert.ok(out.includes("$&amp;&lt;/title&gt;$1&#39;"));
  assert.ok(out.includes('content="https://x/&quot;"'));
});
