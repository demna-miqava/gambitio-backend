import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import type { FastifyInstance } from "fastify";
import { connect, createUser, integrationEnabled, move, resetDb, startTestApp, type TestSocket } from "./helpers.js";
import { createGame } from "../src/services/gameService.js";
import { UserService } from "../src/services/userService.js";

describe("game chat", { skip: !integrationEnabled && "TEST_POSTGRES_URL / TEST_REDIS_URL not set" }, () => {
  let app: FastifyInstance;
  let baseUrl: string;
  let white: { id: number; clerkId: string };
  let black: { id: number; clerkId: string };
  const sockets: TestSocket[] = [];

  const open = async (path: string, clerkId: string) => {
    const socket = await connect(baseUrl, path, clerkId);
    sockets.push(socket);
    return socket;
  };
  const newGame = () =>
    app.pg.transact((tx) => createGame(tx, { whiteId: white.id, blackId: black.id, time: 180, increment: 0 }));
  const joinGame = async (gameId: number) => {
    const w = await open(`/game/${gameId}`, white.clerkId);
    const b = await open(`/game/${gameId}`, black.clerkId);
    const state = await w.next("initial_game_state");
    await b.next("initial_game_state");
    return { w, b, state };
  };
  const say = (text: string) => ({ type: "chat", text });
  const allowChatFrom = (user: { id: number }, from: "everyone" | "only_friends" | "nobody") =>
    app.pg.query(
      `INSERT INTO user_settings ("userId", "gameChatAllowedFrom") VALUES ($1, $2)
       ON CONFLICT ("userId") DO UPDATE SET "gameChatAllowedFrom" = EXCLUDED."gameChatAllowedFrom"`,
      [user.id, from]
    );
  const stored = async () =>
    (await app.pg.query<{ body: string; senderId: number }>(
      `SELECT body, "senderId" FROM game_chat_messages ORDER BY id`
    )).rows;

  before(async () => {
    ({ app, baseUrl } = await startTestApp());
  });
  after(async () => {
    await app.close();
  });
  beforeEach(async () => {
    await Promise.all(sockets.splice(0).map((s) => s.close()));
    await resetDb(app);
    white = await createUser(app, "whitey");
    black = await createUser(app, "blacky");
  });

  test("the two players talk; the sender gets their own message back", async () => {
    const game = await newGame();
    const { w, b, state } = await joinGame(game.id);
    assert.deepEqual(state.data.chat, { enabled: true, reason: null, messages: [] });

    w.send(say("  good   luck\n"));
    const received = await b.next("chat");
    assert.equal(received.data.text, "good luck");
    assert.equal(received.data.userId, white.id);
    assert.equal(typeof received.data.id, "string");
    assert.equal(Math.abs(received.data.at - Date.now()) < 10_000, true);
    assert.deepEqual((await w.next("chat")).data, received.data);

    b.send(say("you too"));
    assert.equal((await w.next("chat")).data.userId, black.id);
  });

  test("markup and SQL arrive as the text they are", async () => {
    const game = await newGame();
    const { w, b } = await joinGame(game.id);
    const nasty = [
      `<script>alert(1)</script>`,
      `<img src=x onerror="alert(1)">`,
      `'; DROP TABLE game_chat_messages; --`,
      `$1 $2 \\' " \\\\ %s {{7*7}}`,
    ];
    for (const text of nasty) {
      w.send(say(text));
      assert.equal((await b.next("chat")).data.text, text);
    }
    // Stored verbatim (the table is still there to ask), and replayed the same
    assert.deepEqual((await stored()).map((row) => row.body), nasty);
    const again = await open(`/game/${game.id}`, black.clerkId);
    const state = await again.next("initial_game_state");
    assert.deepEqual(state.data.chat.messages.map((m: { text: string }) => m.text), nasty);
  });

  test("the sender is the socket's user, whatever the message claims", async () => {
    const game = await newGame();
    const { w, b } = await joinGame(game.id);
    // Unknown fields are dropped by the schema; the author is never read from the message
    w.send({ type: "chat", text: "it was me", userId: black.id, senderId: black.id, gameId: 999 });
    assert.equal((await b.next("chat")).data.userId, white.id);
    assert.deepEqual(await stored(), [{ body: "it was me", senderId: white.id }]);
  });

  test("spectators neither see nor send chat", async () => {
    const watcher = await createUser(app, "watcher");
    const game = await newGame();
    const { w, b } = await joinGame(game.id);
    w.send(say("before they joined"));
    await b.next("chat");

    const s = await open(`/game/${game.id}`, watcher.clerkId);
    const state = await s.next("initial_game_state");
    assert.equal("chat" in state.data, false);

    w.send(say("just between us"));
    await b.next("chat");
    // They do get the game itself
    w.send(move("e2e4"));
    await s.next("move");
    await s.none("chat");

    s.send(say("psst, play Nf3"));
    assert.equal((await s.next("error")).data.code, "NOT_A_PLAYER");
    await b.none("chat");
    assert.equal((await stored()).length, 2);
  });

  test("a player of another game can't write in this one", async () => {
    const other = await createUser(app, "other");
    const game = await newGame();
    const { b } = await joinGame(game.id);
    const o = await open(`/game/${game.id}`, other.clerkId);
    await o.next("initial_game_state");
    o.send(say("hello"));
    assert.equal((await o.next("error")).data.code, "NOT_A_PLAYER");
    await b.none("chat");
  });

  test("empty and oversized messages are refused", async () => {
    const game = await newGame();
    const { w, b } = await joinGame(game.id);
    w.send(say("   "));
    assert.equal((await w.next("error")).data.code, "CHAT_EMPTY");
    w.send(say("a".repeat(201)));
    assert.equal((await w.next("error")).data.code, "CHAT_TOO_LONG");
    // Past the raw limit the schema refuses it before anything reads it
    w.send(say("a".repeat(501)));
    assert.equal((await w.next("error")).data.code, "INVALID_MESSAGE");
    w.send({ type: "chat", text: 42 });
    assert.equal((await w.next("error")).data.code, "INVALID_MESSAGE");
    w.send(say("a".repeat(200)));
    assert.equal((await b.next("chat")).data.text.length, 200);
    assert.equal((await stored()).length, 1);
  });

  test("the rate limit is per player across their sockets", async () => {
    const game = await newGame();
    const { w, b } = await joinGame(game.id);
    const w2 = await open(`/game/${game.id}`, white.clerkId);
    await w2.next("initial_game_state");

    for (let i = 0; i < 5; i++) (i % 2 ? w : w2).send(say(`message ${i}`));
    for (let i = 0; i < 5; i++) await b.next("chat");
    // A second tab doesn't get its own allowance
    w2.send(say("one too many"));
    assert.equal((await w2.next("error")).data.code, "CHAT_RATE_LIMITED");
    // The other player has their own
    b.send(say("slow down"));
    await w.next("chat", (m) => m.data.userId === black.id);
    assert.equal((await stored()).length, 6);
  });

  test("a player can write only so many messages in one game", async () => {
    const game = await newGame();
    const { w } = await joinGame(game.id);
    await app.pg.query(
      `INSERT INTO game_chat_messages ("gameId", "senderId", body)
       SELECT $1, $2, 'filler ' || n FROM generate_series(1, 100) n`,
      [game.id, white.id]
    );
    w.send(say("one more"));
    assert.equal((await w.next("error")).data.code, "CHAT_LIMIT_REACHED");
    // Reconnecting shows the latest 50, oldest first
    const again = await open(`/game/${game.id}`, white.clerkId);
    const { messages } = (await again.next("initial_game_state")).data.chat;
    assert.equal(messages.length, 50);
    assert.equal(messages[0].text, "filler 51");
    assert.equal(messages[49].text, "filler 100");
  });

  test("either player's settings can turn chat off", async () => {
    const game = await newGame();
    await allowChatFrom(black, "nobody");
    const { w, b, state } = await joinGame(game.id);
    assert.deepEqual(state.data.chat, { enabled: false, reason: "off_by_opponent", messages: [] });

    w.send(say("hello?"));
    assert.equal((await w.next("error")).data.code, "CHAT_DISABLED");
    b.send(say("hello?"));
    assert.equal((await b.next("error")).data.code, "CHAT_DISABLED");
    await w.none("chat");

    const bAgain = await open(`/game/${game.id}`, black.clerkId);
    assert.equal((await bAgain.next("initial_game_state")).data.chat.reason, "off_by_you");
    assert.equal((await stored()).length, 0);
  });

  test("turning chat off or on during a game tells both players at once", async () => {
    const game = await newGame();
    const { w, b } = await joinGame(game.id);
    w.send(say("hello"));
    await b.next("chat");
    const setChat = (clerkId: string, from: string) =>
      app.inject({
        method: "PATCH",
        url: "/api/settings",
        headers: { authorization: `Bearer ${clerkId}` },
        payload: { gameChatAllowedFrom: from },
      });

    assert.equal((await setChat(black.clerkId, "nobody")).statusCode, 200);
    // The opponent is told who turned it off; earlier messages go with it
    assert.deepEqual((await w.next("chat_status")).data, {
      enabled: false,
      reason: "off_by_opponent",
      messages: [],
    });
    assert.equal((await b.next("chat_status")).data.reason, "off_by_you");
    w.send(say("anyone there?"));
    assert.equal((await w.next("error")).data.code, "CHAT_DISABLED");

    await setChat(black.clerkId, "everyone");
    const back = (await w.next("chat_status")).data;
    assert.equal(back.enabled, true);
    assert.deepEqual(back.messages.map((m: { text: string }) => m.text), ["hello"]);
    await b.next("chat_status");

    // Another setting says nothing about chat; nor does a player with no game
    await app.inject({
      method: "PATCH",
      url: "/api/settings",
      headers: { authorization: `Bearer ${black.clerkId}` },
      payload: { soundsEnabled: false },
    });
    await w.none("chat_status");
    const idle = await createUser(app, "idle");
    assert.equal((await setChat(idle.clerkId, "nobody")).statusCode, 200);
    await w.none("chat_status");

    // A spectator hears nothing either way
    const watcher = await createUser(app, "watcher");
    const s = await open(`/game/${game.id}`, watcher.clerkId);
    await s.next("initial_game_state");
    await setChat(white.clerkId, "only_friends");
    await b.next("chat_status");
    await s.none("chat_status");
  });

  test("friends-only chat works between friends", async () => {
    const game = await newGame();
    await allowChatFrom(white, "only_friends");
    const { w, b } = await joinGame(game.id);
    b.send(say("hi"));
    assert.equal((await b.next("error")).data.code, "CHAT_DISABLED");

    await app.pg.query(`INSERT INTO friends ("userOneId", "userTwoId") VALUES ($1, $2)`, [black.id, white.id]);
    b.send(say("hi"));
    assert.equal((await w.next("chat")).data.text, "hi");
  });

  test("the chat stays open briefly after the game, then closes", async () => {
    const game = await newGame();
    const { w, b } = await joinGame(game.id);
    w.send(move("e2e4"));
    // Not sent back to back: the two sockets' messages can arrive in either order
    await b.next("move", (m) => m.move.lan === "e2e4");
    b.send(move("e7e5"));
    await w.next("move", (m) => m.move.lan === "e7e5");
    w.send({ type: "resign" });
    await b.next("game_ended");

    b.send(say("good game"));
    assert.equal((await w.next("chat")).data.text, "good game");

    await app.pg.query(`UPDATE games SET "endedAt" = now() - interval '11 minutes' WHERE id = $1`, [game.id]);
    b.send(say("still there?"));
    assert.equal((await b.next("error")).data.code, "CHAT_CLOSED");
    // The conversation can still be read
    const again = await open(`/game/${game.id}`, white.clerkId);
    const { chat } = (await again.next("initial_game_state")).data;
    assert.equal(chat.enabled, false);
    assert.equal(chat.reason, "closed");
    assert.equal(chat.messages.length, 1);
  });

  test("bot games have no chat", async () => {
    const { rows } = await app.pg.query<{ id: number }>(
      `INSERT INTO games ("whiteId", "blackId", "whiteUsername", "blackUsername", "whiteRating", "blackRating",
         "botId", status, result, "endReason", "endedAt", pgn, fen, "numMoves", rated)
       VALUES ($1, NULL, 'whitey', 'Bot', 1200, 1200, 'bot-1', 'finished', 'white_win', 'checkmate', now(), '', '', 0, false)
       RETURNING id`,
      [white.id]
    );
    assert.equal(await app.gameChat.state(rows[0]!.id, white.id), null);
    await assert.rejects(app.gameChat.send(rows[0]!.id, white.id, "hello"), { code: "GAME_NOT_FOUND" });
  });

  test("messages are swept an hour after their game ends, however old they are", async () => {
    const game = await newGame();
    const { w, b } = await joinGame(game.id);
    w.send(say("from white"));
    await b.next("chat");
    b.send(say("from black"));
    await w.next("chat", (m) => m.data.userId === black.id);
    const both = [
      { body: "from white", senderId: white.id },
      { body: "from black", senderId: black.id },
    ];

    // A long game keeps its messages while it is being played
    await app.pg.query(`UPDATE game_chat_messages SET "createdAt" = now() - interval '2 days'`);
    await app.gameChat.sweep();
    assert.deepEqual(await stored(), both);

    // ...and for a while after it ends
    w.send({ type: "resign" });
    await b.next("game_ended");
    await app.pg.query(`UPDATE games SET "endedAt" = now() - interval '50 minutes' WHERE id = $1`, [game.id]);
    await app.gameChat.sweep();
    assert.deepEqual(await stored(), both);

    await app.pg.query(`UPDATE games SET "endedAt" = now() - interval '61 minutes' WHERE id = $1`, [game.id]);
    await app.gameChat.sweep();
    assert.deepEqual(await stored(), []);
  });

  test("a deleted account's messages go with it", async () => {
    const game = await newGame();
    const { w, b } = await joinGame(game.id);
    w.send(say("from white"));
    await b.next("chat");
    b.send(say("from black"));
    await w.next("chat", (m) => m.data.userId === black.id);

    await new UserService(app).deleteAccount(black.clerkId);
    assert.deepEqual(await stored(), [{ body: "from white", senderId: white.id }]);
  });
});
