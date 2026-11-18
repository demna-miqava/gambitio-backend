import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import type { FastifyInstance } from "fastify";
import {
  connect,
  createUser,
  integrationEnabled,
  move,
  resetDb,
  startTestApp,
  type TestSocket,
} from "./helpers.js";
import { createGame } from "../src/services/gameService.js";
import { MAX_ROOMS_PER_OWNER, STUDY_CHAT_BURST } from "../src/services/studyService.js";
import { RETENTION_AFTER_END_MS } from "../src/services/gameChatService.js";
import { MAX_STUDY_NODES } from "../src/game/studyState.js";

const skip = !integrationEnabled && "TEST_POSTGRES_URL / TEST_REDIS_URL not set";
type User = { id: number; clerkId: string };

describe("watch together: study rooms linked to a live game", { skip }, () => {
  let app: FastifyInstance;
  let baseUrl: string;
  let white: User;
  let black: User;
  let ann: User;
  let ben: User;
  const sockets: TestSocket[] = [];

  const open = async (path: string, user: User) => {
    const socket = await connect(baseUrl, path, user.clerkId);
    sockets.push(socket);
    return socket;
  };
  const request = (method: "GET" | "POST" | "DELETE", url: string, user: User, payload?: object) =>
    app.inject({ method, url, headers: { authorization: `Bearer ${user.clerkId}` }, ...(payload && { payload }) });
  const befriend = (a: User, b: User) =>
    app.pg.query(`INSERT INTO friends ("userOneId", "userTwoId") VALUES ($1, $2)`, [a.id, b.id]);
  const newGame = (tournament?: { id: number; rated: boolean }) =>
    app.pg.transact((tx) =>
      createGame(tx, { whiteId: white.id, blackId: black.id, time: 300, increment: 0, ...(tournament && { tournament }) })
    );
  /** Plays moves through the players' game sockets and waits for each. */
  const play = async (gameId: number, ucis: string[]) => {
    const w = await open(`/game/${gameId}`, white);
    const b = await open(`/game/${gameId}`, black);
    await w.next("initial_game_state");
    await b.next("initial_game_state");
    for (const [i, uci] of ucis.entries()) {
      (i % 2 === 0 ? w : b).send(move(uci));
      await (i % 2 === 0 ? b : w).next("move", (m) => m.move.lan === uci);
    }
    return { w, b };
  };
  const createLinked = (gameId: number, user = ann) =>
    request("POST", "/api/study", user, { name: "Watching", gameId });
  /** Ann's room on the game, with Ben invited */
  const linkedRoom = async (gameId: number) => {
    const created = await createLinked(gameId);
    assert.equal(created.statusCode, 201, created.body);
    const roomId: number = created.json().room.id;
    await befriend(ann, ben);
    assert.equal((await request("POST", `/api/study/${roomId}/members`, ann, { userId: ben.id })).statusCode, 201);
    return roomId;
  };
  const resign = async (gameId: number) => {
    await app.liveGames.resign(gameId, black.id);
  };

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
    ann = await createUser(app, "annie");
    ben = await createUser(app, "benny");
  });

  test("a spectator's room starts from the game's moves and follows them with sync_game", async () => {
    const game = await newGame();
    const { w, b } = await play(game.id, ["e2e4", "e7e5"]);
    const roomId = await linkedRoom(game.id);

    const sa = await open(`/study/${roomId}`, ann);
    const first = await sa.next("study_state");
    assert.equal(first.room.gameId, game.id);
    assert.equal(first.state.game.line.length, 2);
    assert.equal(first.state.game.over, false);
    // Watching live: at the latest move
    assert.equal(first.state.cursor, first.state.game.line[1]);
    assert.deepEqual(first.chat, { enabled: true, reason: null, messages: [] });
    const sb = await open(`/study/${roomId}`, ben);
    await sb.next("study_state");

    // Nothing new: nothing changes, nothing is sent
    sa.send({ type: "sync_game" });
    await sb.none("game_line");

    w.send(move("g1f3"));
    await b.next("move", (m) => m.move.lan === "g1f3");
    // Both members ask for the same move: the first does the work
    sa.send({ type: "sync_game" });
    sb.send({ type: "sync_game" });
    const update = await sb.next("game_line");
    assert.equal(update.game.line.length, 3);
    assert.equal(update.nodes.find((n: { san: string }) => n.san === "Nf3")?.id, update.game.line[2]);
    assert.equal(update.cursor, update.game.line[2]);
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(sb.messages.filter((m) => m.type === "game_line").length, 1);
    const { rows } = await app.pg.query(`SELECT version FROM study_rooms WHERE id = $1`, [roomId]);
    assert.equal(rows[0].version, update.version);

    // The game's moves stay the main line while it is played
    sa.send({ type: "delete", nodeId: update.game.line[2] });
    assert.equal((await sa.next("error")).data.code, "INVALID_STUDY_ACTION");

    // Once it ends the room knows, and it is an ordinary room
    await resign(game.id);
    sb.send({ type: "sync_game" });
    const ended = await sa.next("game_line", (m) => m.game.over === true);
    assert.equal(ended.game.line.length, 3);
    sa.send({ type: "delete", nodeId: update.game.line[2] });
    await sb.next("node_deleted");

    // The deleted move leaves the stored line, and no later sync (a member
    // connecting) puts it back
    const stored = async () =>
      (await app.pg.query(`SELECT state, version FROM study_rooms WHERE id = $1`, [roomId])).rows[0];
    const afterDelete = await stored();
    assert.deepEqual(afterDelete.state.game, { line: update.game.line.slice(0, 2), over: true });
    await sb.next("game_line", (m) => m.game.over === true);
    sa.send({ type: "sync_game" });
    sb.send({ type: "sync_game" });
    await sb.none("game_line");
    assert.equal((await stored()).version, afterDelete.version);
    const reconnected = await open(`/study/${roomId}`, ben);
    const fresh = await reconnected.next("study_state");
    assert.deepEqual(fresh.state.game.line, update.game.line.slice(0, 2));
    assert.equal(Object.hasOwn(fresh.state.nodes, update.game.line[2]), false);
  });

  test("a room too full for the game's line isn't replayed again until it changes", async () => {
    const game = await newGame();
    await play(game.id, ["e2e4"]);
    const created = await createLinked(game.id);
    const roomId: number = created.json().room.id;
    // Fill the tree to MAX_STUDY_NODES with moves of the members' own (the
    // root's children, none of them the game's move)
    const { rows } = await app.pg.query(`SELECT state FROM study_rooms WHERE id = $1`, [roomId]);
    const state = rows[0].state;
    const root = state.nodes.root;
    state.nodes.root = { ...root, children: [] };
    for (const id of Object.keys(state.nodes)) if (id !== "root") delete state.nodes[id];
    for (let i = 1; i < MAX_STUDY_NODES; i++) {
      const id = `d${i}`;
      state.nodes[id] = { id, parentId: "root", san: "x", uci: "a1a1", fen: root.fen, ply: 1, children: [], comment: "", shapes: [] };
      state.nodes.root.children.push(id);
    }
    state.game = { line: [], over: false };
    await app.pg.query(`UPDATE study_rooms SET state = $2::jsonb, cursor = 'root', "nodeCount" = $3 WHERE id = $1`, [
      roomId,
      JSON.stringify(state),
      MAX_STUDY_NODES,
    ]);

    // Counts the locked replays
    const transact = app.pg.transact;
    let replays = 0;
    app.pg.transact = ((...args: Parameters<typeof transact>) => {
      replays++;
      return transact.apply(app.pg, args);
    }) as typeof transact;
    try {
      await assert.rejects(app.study.apply(roomId, ann.id, { type: "sync_game" }), /up to 1000 moves/);
      assert.equal(replays, 1);
      // Every member's sync_game after that gets the same answer, without a replay
      await assert.rejects(app.study.apply(roomId, ann.id, { type: "sync_game" }), /up to 1000 moves/);
      await assert.rejects(app.study.apply(roomId, ann.id, { type: "sync_game" }), /up to 1000 moves/);
      assert.equal(replays, 1);

      // A variation deleted: the next sync takes the line, and forgets the refusal
      await app.study.apply(roomId, ann.id, { type: "delete", nodeId: "d1" });
      const before = replays;
      await app.study.apply(roomId, ann.id, { type: "sync_game" });
      assert.equal(replays, before + 1);
      const { rows: after } = await app.pg.query(`SELECT state FROM study_rooms WHERE id = $1`, [roomId]);
      assert.equal(after[0].state.game.line.length, 1);
      assert.equal(await app.redis.get(`study:gamesync:refused:${roomId}`), null);
    } finally {
      app.pg.transact = transact;
    }
  });

  test("an ordinary room has no game to sync and no chat", async () => {
    const created = await request("POST", "/api/study", ann, { name: "Plain" });
    const roomId = created.json().room.id;
    const sa = await open(`/study/${roomId}`, ann);
    const state = await sa.next("study_state");
    assert.equal(state.room.gameId, null);
    assert.equal(state.chat, undefined);
    sa.send({ type: "sync_game" });
    assert.equal((await sa.next("error")).data.code, "STUDY_NOT_LINKED");
    sa.send({ type: "chat", text: "hello" });
    assert.equal((await sa.next("error", (m) => m.data.code !== "STUDY_NOT_LINKED")).data.code, "CHAT_UNAVAILABLE");
  });

  test("a game watched this way must be live, between two players, and someone else's", async () => {
    const game = await newGame();
    for (const player of [white, black]) {
      const asPlayer = await createLinked(game.id, player);
      assert.equal(asPlayer.statusCode, 403);
      assert.match(asPlayer.body, /GAME_PLAYER/);
    }
    assert.equal((await createLinked(999_999)).statusCode, 404);
    // Not both a start position and a game
    assert.equal(
      (await request("POST", "/api/study", ann, { name: "x", gameId: game.id, moves: ["e4"] })).statusCode,
      400
    );
    await resign(game.id);
    const finished = await createLinked(game.id);
    assert.equal(finished.statusCode, 409);
    assert.match(finished.body, /GAME_NOT_LIVE/);
  });

  test("fair play: the players can't join, be invited to, read or open the room until the game ends", async () => {
    const game = await newGame();
    await play(game.id, ["e2e4"]);
    const roomId = await linkedRoom(game.id);
    await befriend(ann, white);

    // White's notifications socket must get nothing about the room
    const notes = await open("/notifications", white);
    const invited = await request("POST", `/api/study/${roomId}/members`, ann, { userId: white.id });
    assert.equal(invited.statusCode, 409);
    assert.match(invited.body, /GAME_IN_PROGRESS/);
    const { rows: members } = await app.pg.query(`SELECT "userId" FROM study_room_members WHERE "roomId" = $1`, [roomId]);
    assert.equal(members.some((m) => m.userId === white.id), false);

    // Even a player who somehow is a member (data from before, a race) is kept out everywhere
    await app.pg.query(`INSERT INTO study_room_members ("roomId", "userId") VALUES ($1, $2)`, [roomId, white.id]);
    assert.equal((await request("GET", `/api/study/${roomId}`, white)).statusCode, 404);
    assert.deepEqual((await request("GET", "/api/study", white)).json().rooms, []);
    const refused = await open(`/study/${roomId}`, white);
    assert.equal((await refused.next("error")).data.code, "STUDY_NOT_FOUND");
    await refused.none("study_state");
    for (const op of [
      { type: "sync_game" as const },
      { type: "goto" as const, nodeId: "root" },
      { type: "move" as const, nodeId: "root", uci: "d2d4" },
      { type: "comment" as const, nodeId: "root", text: "psst" },
    ]) {
      await assert.rejects(app.study.apply(roomId, white.id, op), /not found/i);
    }
    await assert.rejects(app.study.sendChat(roomId, white.id, "hint"), /not found/i);
    // Nor can they invite anyone, remove anyone or start a room on their game
    await befriend(white, ben);
    assert.equal((await request("POST", `/api/study/${roomId}/members`, white, { userId: ben.id })).statusCode, 404);
    assert.equal((await request("DELETE", `/api/study/${roomId}/members/${ben.id}`, white)).statusCode, 404);
    await app.pg.query(`DELETE FROM study_room_members WHERE "roomId" = $1 AND "userId" = $2`, [roomId, white.id]);

    await new Promise((r) => setTimeout(r, 200));
    assert.equal(notes.messages.some((m) => m.type === "study_invite"), false);

    // The game ends: the room is ordinary and the players can be invited
    await resign(game.id);
    assert.equal((await request("POST", `/api/study/${roomId}/members`, ann, { userId: white.id })).statusCode, 201);
    assert.equal((await notes.next("study_invite")).data.roomId, roomId);
    const sw = await open(`/study/${roomId}`, white);
    const state = await sw.next("study_state");
    // ...but never get the spectators' chat
    assert.equal(state.chat, undefined);
    sw.send({ type: "chat", text: "gg" });
    assert.equal((await sw.next("error")).data.code, "CHAT_UNAVAILABLE");
    assert.equal((await request("GET", "/api/study", white)).json().rooms.length, 1);
  });

  test("room chat: cleaned, rate limited, kept for a reload, kept from blocked members and the players", async () => {
    const game = await newGame();
    const roomId = await linkedRoom(game.id);
    const sa = await open(`/study/${roomId}`, ann);
    const sb = await open(`/study/${roomId}`, ben);
    await sa.next("study_state");
    await sb.next("study_state");

    sa.send({ type: "chat", text: "  Nice​   move\n\n!  " });
    const got = await sb.next("chat");
    assert.equal(got.data.text, "Nice move !");
    assert.equal(got.data.userId, ann.id);
    // The sender's own copy is the confirmation
    assert.equal((await sa.next("chat")).data.id, got.data.id);
    sa.send({ type: "chat", text: "​ " });
    assert.equal((await sa.next("error")).data.code, "CHAT_EMPTY");
    sa.send({ type: "chat", text: "x".repeat(201) });
    assert.equal((await sa.next("error", (m) => m.data.code !== "CHAT_EMPTY")).data.code, "CHAT_TOO_LONG");

    // A reload brings the history back
    const again = await open(`/study/${roomId}`, ben);
    assert.deepEqual(
      (await again.next("study_state")).chat.messages.map((m: { text: string }) => m.text),
      ["Nice move !"]
    );

    // Too fast
    await app.redis.flushDb();
    for (let i = 0; i < STUDY_CHAT_BURST.max; i++) await app.study.sendChat(roomId, ben.id, `m${i}`);
    await assert.rejects(app.study.sendChat(roomId, ben.id, "one more"), /too fast/);

    // A block cuts chat both ways, history included
    await app.pg.query(`INSERT INTO user_blocks ("blockerId", "blockedId") VALUES ($1, $2)`, [ann.id, ben.id]);
    await app.redis.flushDb();
    const before = sa.messages.filter((m) => m.type === "chat").length;
    await app.study.sendChat(roomId, ben.id, "can you see this");
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(sa.messages.filter((m) => m.type === "chat").length, before);
    const annReload = await open(`/study/${roomId}`, ann);
    const texts = (await annReload.next("study_state")).chat.messages.map((m: { text: string }) => m.text);
    assert.deepEqual(texts, ["Nice move !"]);
  });

  test("room chat follows each member's game-chat setting, as game chat does", async () => {
    const game = await newGame();
    const roomId = await linkedRoom(game.id);
    // Carl is Ann's friend, not Ben's
    const carl = await createUser(app, "carly");
    await befriend(ann, carl);
    assert.equal((await request("POST", `/api/study/${roomId}/members`, ann, { userId: carl.id })).statusCode, 201);
    const setting = (user: User, value: string) =>
      app.pg.query(
        `INSERT INTO user_settings ("userId", "gameChatAllowedFrom") VALUES ($1, $2)
         ON CONFLICT ("userId") DO UPDATE SET "gameChatAllowedFrom" = EXCLUDED."gameChatAllowedFrom"`,
        [user.id, value]
      );
    await app.study.sendChat(roomId, carl.id, "before");

    // Ben: friends only. Ann's messages reach him and his reach her; Carl's don't
    await setting(ben, "only_friends");
    const sa = await open(`/study/${roomId}`, ann);
    const sb = await open(`/study/${roomId}`, ben);
    const sc = await open(`/study/${roomId}`, carl);
    assert.deepEqual((await sb.next("study_state")).chat.messages, []);
    await sa.next("study_state");
    await sc.next("study_state");
    await app.study.sendChat(roomId, ann.id, "from ann");
    assert.equal((await sb.next("chat")).data.text, "from ann");
    await app.study.sendChat(roomId, carl.id, "from carl");
    await app.study.sendChat(roomId, ben.id, "from ben");
    assert.equal((await sa.next("chat", (m) => m.data.text === "from ben")).data.userId, ben.id);
    // His own copy comes back; Carl's message never did
    await sb.next("chat", (m) => m.data.text === "from ben");
    assert.equal(sb.messages.some((m) => m.type === "chat" && m.data.text === "from carl"), false);
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(sc.messages.some((m) => m.type === "chat" && m.data.text === "from ben"), false);

    // Ben: nobody. No chat at all: nothing to read, can't write, sent nothing
    await setting(ben, "nobody");
    await app.redis.flushDb();
    const reload = await open(`/study/${roomId}`, ben);
    assert.deepEqual((await reload.next("study_state")).chat, { enabled: false, reason: "off_by_you", messages: [] });
    reload.send({ type: "chat", text: "hi" });
    assert.equal((await reload.next("error")).data.code, "CHAT_DISABLED");
    await app.study.sendChat(roomId, ann.id, "anyone?");
    await sa.next("chat", (m) => m.data.text === "anyone?");
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(reload.messages.some((m) => m.type === "chat"), false);
  });

  test("a member can report another from the room, with the room's chat", async () => {
    const game = await newGame();
    const roomId = await linkedRoom(game.id);
    await app.study.sendChat(roomId, ben.id, "rude words");
    const report = (user: User, payload: object) => request("POST", "/api/reports", user, payload);

    const filed = await report(ann, { reportedId: ben.id, reason: "abusive_chat", studyRoomId: roomId });
    assert.equal(filed.statusCode, 201, filed.body);
    const { rows } = await app.pg.query(`SELECT "studyRoomId", "gameId", "chatExcerpt" FROM user_reports WHERE id = $1`, [
      filed.json().data.id,
    ]);
    assert.equal(rows[0].studyRoomId, roomId);
    assert.equal(rows[0].gameId, null);
    assert.deepEqual(
      rows[0].chatExcerpt.map((m: { userId: number; text: string }) => [m.userId, m.text]),
      [[ben.id, "rude words"]]
    );

    // Someone who left can still be reported for what they wrote
    const carl = await createUser(app, "carly");
    await app.pg.query(`INSERT INTO study_room_members ("roomId", "userId") VALUES ($1, $2)`, [roomId, carl.id]);
    assert.equal((await request("DELETE", `/api/study/${roomId}/members/${ben.id}`, ben)).statusCode, 204);
    assert.equal((await report(carl, { reportedId: ben.id, reason: "abusive_chat", studyRoomId: roomId })).statusCode, 201);

    // Not from a room they aren't in (Ben left), nor about someone who never
    // was in it nor wrote there, nor by a player of its live game
    const outsider = await report(ben, { reportedId: carl.id, reason: "other", studyRoomId: roomId });
    assert.equal(outsider.statusCode, 400);
    assert.match(outsider.body, /NOT_YOUR_ROOM/);
    await app.pg.query(`INSERT INTO study_room_members ("roomId", "userId") VALUES ($1, $2)`, [roomId, white.id]);
    assert.match((await report(white, { reportedId: ann.id, reason: "other", studyRoomId: roomId })).body, /NOT_YOUR_ROOM/);
    const stranger = await report(carl, { reportedId: black.id, reason: "other", studyRoomId: roomId });
    assert.match(stranger.body, /NOT_YOUR_ROOM/);
    // Not a game and a room at once
    const both = await report(carl, { reportedId: ann.id, reason: "other", studyRoomId: roomId, gameId: game.id });
    assert.equal(both.statusCode, 400);
    assert.match(both.body, /VALIDATION_ERROR/);
  });

  test("room chat closes after the game and goes on game chat's schedule", async () => {
    const game = await newGame();
    const roomId = await linkedRoom(game.id);
    // Another game, still on: its room's chat stays
    const carl = await createUser(app, "carly");
    const dana = await createUser(app, "danny");
    const other = await app.pg.transact((tx) => createGame(tx, { whiteId: carl.id, blackId: dana.id, time: 300, increment: 0 }));
    const keep: number = (await createLinked(other.id, ben)).json().room.id;
    await app.study.sendChat(keep, ben.id, "still here");
    await app.study.sendChat(roomId, ann.id, "first");
    await resign(game.id);
    // Still open a while after the end (for a reload)
    await app.study.sendChat(roomId, ben.id, "gg");
    await app.pg.query(`UPDATE games SET "endedAt" = now() - interval '11 minutes' WHERE id = $1`, [game.id]);
    await assert.rejects(app.study.sendChat(roomId, ann.id, "late"), /closed/);
    const sa = await open(`/study/${roomId}`, ann);
    const state = await sa.next("study_state");
    assert.equal(state.chat.enabled, false);
    assert.equal(state.chat.messages.length, 2);

    // The sweep: an hour after the game ended
    await app.gameChat.sweep();
    assert.equal((await app.pg.query(`SELECT 1 FROM study_chat_messages`)).rows.length, 3);
    await app.pg.query(`UPDATE games SET "endedAt" = now() - ($2::int * interval '1 millisecond') - interval '1 minute' WHERE id = $1`, [
      game.id,
      RETENTION_AFTER_END_MS,
    ]);
    await app.gameChat.sweep();
    const { rows } = await app.pg.query(`SELECT "roomId" FROM study_chat_messages`);
    assert.deepEqual(rows.map((r) => r.roomId), [keep]);
  });

  test("tournament games can be watched this way, and a linked room counts toward the owner's limit", async () => {
    const { rows } = await app.pg.query<{ id: number }>(
      `INSERT INTO tournaments ("createdBy", name, "time", "startsAt", "endsAt", status)
       VALUES ($1, 'Arena', 180, now(), now() + interval '1 hour', 'finished') RETURNING id`,
      [white.id]
    );
    const game = await newGame({ id: rows[0]!.id, rated: true });
    assert.equal(game.tournamentId, rows[0]!.id);
    const roomId = await linkedRoom(game.id);
    assert.ok(roomId);

    // Ordinary rooms up to the limit, besides the linked one
    await app.pg.query(
      `INSERT INTO study_rooms ("ownerId", name, state)
       SELECT $1, 'r' || i, '{"nodes": {}, "nextId": 1}'::jsonb FROM generate_series(1, $2::int) i`,
      [ann.id, MAX_ROOMS_PER_OWNER - 1]
    );
    const full = await createLinked(game.id);
    assert.equal(full.statusCode, 409);
    assert.match(full.body, /TOO_MANY_ROOMS/);
  });
});
