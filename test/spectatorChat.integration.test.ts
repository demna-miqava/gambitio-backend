import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import type { FastifyInstance } from "fastify";
import { connect, createUser, integrationEnabled, move, resetDb, startTestApp, type TestSocket } from "./helpers.js";
import { createGame } from "../src/services/gameService.js";
import { SPECTATOR_CHAT_MAX_PER_USER } from "../src/services/spectatorChatService.js";

const skip = !integrationEnabled && "TEST_POSTGRES_URL / TEST_REDIS_URL not set";

/**
 * Spectator chat over real WebSockets. The rule that matters most: a
 * game's players never receive spectator messages, whatever they do.
 */
describe("spectator chat", { skip }, () => {
  let app: FastifyInstance;
  let baseUrl: string;
  /** A second instance on the same database and Redis */
  let other: FastifyInstance;
  let otherUrl: string;
  const sockets: TestSocket[] = [];
  let white: { id: number; clerkId: string };
  let black: { id: number; clerkId: string };
  let ann: { id: number; clerkId: string };
  let bob: { id: number; clerkId: string };
  let cat: { id: number; clerkId: string };

  const open = async (gameId: number, who: { clerkId: string }, url = baseUrl) => {
    const socket = await connect(url, `/game/${gameId}`, who.clerkId);
    sockets.push(socket);
    return socket;
  };
  /** A socket with its initial state read */
  const join = async (gameId: number, who: { clerkId: string }, url = baseUrl) => {
    const socket = await open(gameId, who, url);
    const state = await socket.next("initial_game_state");
    return { socket, state };
  };
  const say = (text: string) => ({ type: "spectator_chat", text });
  const newGame = () =>
    app.pg.transact((tx) => createGame(tx, { whiteId: white.id, blackId: black.id, time: 180, increment: 0 }));
  const block = (blockerId: number, blockedId: number) =>
    app.pg.query(`INSERT INTO user_blocks ("blockerId", "blockedId") VALUES ($1, $2)`, [blockerId, blockedId]);
  /** Nothing a player's socket ever received mentions a spectator message */
  const neverSaw = (socket: TestSocket, ...texts: string[]) => {
    const all = JSON.stringify(socket.messages);
    for (const text of texts) assert.equal(all.includes(text), false, `a player's socket received "${text}"`);
    assert.equal(socket.messages.some((m) => m.type === "spectator_chat"), false);
    assert.equal(socket.messages.some((m) => m.data && "spectatorChat" in m.data), false);
  };

  before(async () => {
    ({ app, baseUrl } = await startTestApp());
    ({ app: other, baseUrl: otherUrl } = await startTestApp());
  });
  after(async () => {
    await Promise.all(sockets.splice(0).map((s) => s.close()));
    await other.close();
    await app.close();
  });
  beforeEach(async () => {
    await Promise.all(sockets.splice(0).map((s) => s.close()));
    await resetDb(app);
    other.users.clear();
    white = await createUser(app, "whitey");
    black = await createUser(app, "blacky");
    ann = await createUser(app, "ann");
    bob = await createUser(app, "bob");
    cat = await createUser(app, "cat");
  });

  test("players never get spectator chat: live, after the game, in history, or in a second tab", async () => {
    const game = await newGame();
    const { socket: w, state: wState } = await join(game.id, white);
    const { socket: b } = await join(game.id, black);
    assert.equal("spectatorChat" in wState.data, false);

    const { socket: a, state: aState } = await join(game.id, ann);
    const { socket: o } = await join(game.id, bob);
    assert.deepEqual(aState.data.spectatorChat, { enabled: true, reason: null, messages: [], closesAt: null });

    a.send(say("play Nf3 now"));
    const got = await o.next("spectator_chat");
    assert.equal(got.data.text, "play Nf3 now");
    assert.equal(got.data.userId, ann.id);
    assert.equal(got.data.username, "ann");
    // The sender's own copy
    assert.equal((await a.next("spectator_chat")).data.id, got.data.id);

    // A player can't write in it
    w.send(say("thanks!"));
    assert.equal((await w.next("error")).data.code, "NOT_A_SPECTATOR");

    // A second tab of a player, opened after messages were written: no history
    const { socket: w2, state: w2State } = await join(game.id, white);
    assert.equal("spectatorChat" in w2State.data, false);
    // A resync sends the state again: still none
    b.send({ type: "sync" });
    const resync = await b.next("initial_game_state");
    assert.equal("spectatorChat" in resync.data, false);

    o.send(say("Qh5 is mate in two"));
    await a.next("spectator_chat", (m) => m.data.text === "Qh5 is mate in two");

    // The game ends; spectators still on the page go on
    w.send(move("e2e4"));
    await b.next("move");
    b.send({ type: "resign" });
    await o.next("game_ended");
    o.send(say("good game to watch"));
    await a.next("spectator_chat", (m) => m.data.text === "good game to watch");

    // Players opening the finished game get nothing either
    const { socket: wAfter, state: wAfterState } = await join(game.id, white);
    assert.equal("spectatorChat" in wAfterState.data, false);
    // A spectator joining after the end reads it all
    const { state: lateState } = await join(game.id, cat);
    assert.deepEqual(
      lateState.data.spectatorChat.messages.map((m: { text: string }) => m.text),
      ["play Nf3 now", "Qh5 is mate in two", "good game to watch"]
    );
    assert.equal(lateState.data.spectatorChat.enabled, true);
    assert.ok(lateState.data.spectatorChat.closesAt > Date.now());

    await w.none("spectator_chat");
    for (const socket of [w, b, w2, wAfter]) {
      neverSaw(socket, "play Nf3 now", "Qh5 is mate in two", "good game to watch");
    }
  });

  test("across instances: spectators elsewhere get it, players elsewhere don't", async () => {
    const game = await newGame();
    // Black and Bob on the other instance
    const { socket: b } = await join(game.id, black, otherUrl);
    const { socket: o } = await join(game.id, bob, otherUrl);
    const { socket: w } = await join(game.id, white);
    const { socket: a } = await join(game.id, ann);

    a.send(say("from instance one"));
    await o.next("spectator_chat", (m) => m.data.text === "from instance one");
    o.send(say("from instance two"));
    await a.next("spectator_chat", (m) => m.data.text === "from instance two");
    await b.none("spectator_chat", 400);
    neverSaw(b, "from instance one", "from instance two");
    neverSaw(w, "from instance one", "from instance two");
  });

  test("a block either way keeps messages from being delivered, live and in history, on any instance", async () => {
    const game = await newGame();
    const { socket: a } = await join(game.id, ann);
    // Bob blocked Ann; Ann blocked Cat. Bob is on the other instance
    await block(bob.id, ann.id);
    await block(ann.id, cat.id);
    const { socket: o } = await join(game.id, bob, otherUrl);
    const { socket: c } = await join(game.id, cat);
    const dan = await createUser(app, "dan");
    const { socket: d } = await join(game.id, dan, otherUrl);

    a.send(say("ann speaking"));
    await d.next("spectator_chat", (m) => m.data.text === "ann speaking");
    await a.next("spectator_chat");
    o.send(say("bob speaking"));
    await d.next("spectator_chat", (m) => m.data.text === "bob speaking");
    await c.next("spectator_chat", (m) => m.data.text === "bob speaking");
    c.send(say("cat speaking"));
    await d.next("spectator_chat", (m) => m.data.text === "cat speaking");
    await o.next("spectator_chat", (m) => m.data.text === "cat speaking");

    await a.none("spectator_chat", 300);
    // Ann got only her own message; Bob and Cat never got Ann's, nor she theirs
    assert.deepEqual(
      a.messages.filter((m) => m.type === "spectator_chat").map((m) => m.data.text),
      ["ann speaking"]
    );
    assert.equal(o.messages.some((m) => m.type === "spectator_chat" && m.data.userId === ann.id), false);
    assert.equal(c.messages.some((m) => m.type === "spectator_chat" && m.data.userId === ann.id), false);

    // History leaves them out the same way
    const history = async (who: { clerkId: string }) =>
      (await join(game.id, who)).state.data.spectatorChat.messages.map((m: { text: string }) => m.text);
    assert.deepEqual(await history(ann), ["ann speaking"]);
    assert.deepEqual(await history(bob), ["bob speaking", "cat speaking"]);
    assert.deepEqual(await history(cat), ["bob speaking", "cat speaking"]);
    assert.deepEqual(await history(dan), ["ann speaking", "bob speaking", "cat speaking"]);
  });

  test("the rate limit holds across a viewer's sockets, and the per-game cap", async () => {
    const game = await newGame();
    const { socket: a } = await join(game.id, ann);
    const { socket: a2 } = await join(game.id, ann);
    const { socket: o } = await join(game.id, bob);
    for (let i = 0; i < 5; i++) (i % 2 ? a : a2).send(say(`message ${i}`));
    for (let i = 0; i < 5; i++) await o.next("spectator_chat");
    a2.send(say("one too many"));
    assert.equal((await a2.next("error")).data.code, "CHAT_RATE_LIMITED");
    // Others have their own allowance
    o.send(say("slow down"));
    await a.next("spectator_chat", (m) => m.data.userId === bob.id);

    await app.pg.query(
      `INSERT INTO spectator_chat_messages ("gameId", "senderId", body)
       SELECT $1, $2, 'old ' || i FROM generate_series(1, $3::int) i`,
      [game.id, cat.id, SPECTATOR_CHAT_MAX_PER_USER]
    );
    const { socket: c } = await join(game.id, cat);
    c.send(say("and another"));
    assert.equal((await c.next("error")).data.code, "CHAT_LIMIT_REACHED");
  });

  test("text is cleaned and stays text; empty and long messages are refused", async () => {
    const game = await newGame();
    const { socket: a } = await join(game.id, ann);
    const { socket: o } = await join(game.id, bob);
    a.send(say("  <b>hi</b>‮'); DROP TABLE users;--\n  "));
    assert.equal((await o.next("spectator_chat")).data.text, "<b>hi</b>'); DROP TABLE users;--");
    a.send(say("   "));
    assert.equal((await a.next("error")).data.code, "CHAT_EMPTY");
    a.send(say("a".repeat(201)));
    assert.equal((await a.next("error")).data.code, "CHAT_TOO_LONG");
    const { rows } = await app.pg.query(`SELECT count(*)::int AS n FROM users`);
    assert.equal(rows[0].n, 5);
  });

  test("writing closes after the game, and messages go an hour after it", async () => {
    const game = await newGame();
    const { socket: a } = await join(game.id, ann);
    a.send(say("before the end"));
    await a.next("spectator_chat");
    await app.pg.query(
      `UPDATE games SET status = 'finished', result = 'draw', "endReason" = 'draw_agreement',
         "endedAt" = now() - interval '11 minutes', "deadlineAt" = NULL WHERE id = $1`,
      [game.id]
    );
    a.send(say("too late"));
    assert.equal((await a.next("error")).data.code, "CHAT_CLOSED");
    const { state } = await join(game.id, bob);
    assert.equal(state.data.spectatorChat.enabled, false);
    assert.equal(state.data.spectatorChat.reason, "closed");
    assert.equal(state.data.spectatorChat.messages.length, 1);

    await app.gameChat.sweep();
    assert.equal((await app.pg.query(`SELECT 1 FROM spectator_chat_messages`)).rowCount, 1);
    await app.pg.query(`UPDATE games SET "endedAt" = now() - interval '61 minutes' WHERE id = $1`, [game.id]);
    await app.gameChat.sweep();
    assert.equal((await app.pg.query(`SELECT 1 FROM spectator_chat_messages`)).rowCount, 0);
  });

  test("a spectator reports a message's author, keeping the chat as it stood", async () => {
    const game = await newGame();
    const { socket: a } = await join(game.id, ann);
    const { socket: o } = await join(game.id, bob);
    o.send(say("you are all idiots"));
    await a.next("spectator_chat");
    a.send(say("please stop"));
    await o.next("spectator_chat", (m) => m.data.userId === ann.id);

    const report = (by: { clerkId: string }, payload: object) =>
      app.inject({
        method: "POST",
        url: "/api/reports",
        headers: { authorization: `Bearer ${by.clerkId}` },
        payload: { reason: "abusive_chat", ...payload },
      });
    const res = await report(ann, { reportedId: bob.id, spectatorGameId: game.id });
    assert.equal(res.statusCode, 201, res.body);
    const { rows } = await app.pg.query(
      `SELECT "spectatorGameId", "gameId", "chatExcerpt" FROM user_reports WHERE id = $1`,
      [res.json().data.id]
    );
    assert.equal(rows[0].spectatorGameId, game.id);
    assert.equal(rows[0].gameId, null);
    assert.deepEqual(
      rows[0].chatExcerpt.map((m: { username: string; text: string }) => `${m.username}: ${m.text}`),
      ["bob: you are all idiots", "ann: please stop"]
    );

    // Only someone who wrote there can be reported from it, and not by a player
    assert.equal((await report(bob, { reportedId: cat.id, spectatorGameId: game.id })).statusCode, 400);
    assert.equal((await report(white, { reportedId: bob.id, spectatorGameId: game.id })).statusCode, 400);
    // One context at most
    assert.equal(
      (await report(cat, { reportedId: bob.id, spectatorGameId: game.id, gameId: game.id })).statusCode,
      400
    );
  });
});
