import { after, afterEach, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { FastifyInstance } from "fastify";
import WebSocket from "ws";
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
import { RealtimeHub } from "../src/realtime/hub.js";
import { reauthTimings } from "../src/realtime/socket.js";
import { unverifiedSubject } from "../src/app.js";
import { COLOR_PALETTES } from "../src/models/Settings.js";

/** Covers the scalability pass: deadline timers, presence, sockets, friend requests. */
describe("scalability changes", { skip: !integrationEnabled && "TEST_POSTGRES_URL / TEST_REDIS_URL not set" }, () => {
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
  const newGame = (time = 180, increment = 0) =>
    app.pg.transact((tx) => createGame(tx, { whiteId: white.id, blackId: black.id, time, increment }));
  const joinGame = async (gameId: number) => {
    const w = await open(`/game/${gameId}`, white.clerkId);
    const b = await open(`/game/${gameId}`, black.clerkId);
    await w.next("initial_game_state");
    await b.next("initial_game_state");
    return { w, b };
  };
  const closed = (ws: WebSocket) =>
    new Promise<number>((resolve) => {
      if (ws.readyState === WebSocket.CLOSED) return resolve(-1);
      ws.once("close", (code) => resolve(code));
    });

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
  afterEach(() => {
    app.liveGames.stopDeadlineTimers();
  });

  test("a deadline timer ends the game without any sweep", async () => {
    await app.liveGames.startDeadlineTimers();
    const game = await newGame();
    const { w } = await joinGame(game.id);
    // The first move must come within 300 ms
    const soon = new Date(Date.now() + 300);
    await app.pg.query(`UPDATE games SET "deadlineAt" = $2 WHERE id = $1`, [game.id, soon]);
    app.liveGames.watchDeadline(game.id, soon);
    const ended = await w.next("game_ended", undefined, 3000);
    assert.equal(ended.reason, "aborted");
    assert.equal(app.liveGames.watchedGameCount, 0);
  });

  test("startup arms timers for games already in progress", async () => {
    const game = await newGame();
    await app.liveGames.startDeadlineTimers();
    assert.equal(app.liveGames.watchedGameCount, 1);
    const { b } = await joinGame(game.id);
    b.send({ type: "resign" });
    await b.next("game_ended");
    // An ended game drops its timer
    assert.equal(app.liveGames.watchedGameCount, 0);
  });

  test("move messages carry no PGN, and sync resends the full state", async () => {
    const game = await newGame();
    const { w, b } = await joinGame(game.id);
    w.send(move("e2e4"));
    const moved = await b.next("move", (m) => m.move.lan === "e2e4");
    assert.equal(moved.pgn, undefined);
    assert.match(moved.fen, /^rnbqkbnr\/pppppppp\/8\/8\/4P3/);

    b.send({ type: "sync" });
    const state = await b.next("initial_game_state");
    assert.equal(state.data.numMoves, 1);
    assert.ok(state.data.pgn.includes("1. e4"));
  });

  test("a spectator's timeout hint is ignored", async () => {
    const watcher = await createUser(app, "watcher");
    const second = await newGame();
    const { w: w2 } = await joinGame(second.id);
    const s2 = await open(`/game/${second.id}`, watcher.clerkId);
    await s2.next("initial_game_state");
    await app.pg.query(`UPDATE games SET "deadlineAt" = now() - interval '1 second' WHERE id = $1`, [second.id]);
    s2.send({ type: "timeout" });
    await w2.none("game_ended", 400);
    w2.send({ type: "timeout" });
    assert.equal((await w2.next("game_ended")).reason, "aborted");
  });

  test("players hear on their notifications socket when a game starts and ends", async () => {
    const n = await open("/notifications", white.clerkId);
    // Matchmaking pairs the two of them
    const mw = await open("/matchmaking?time=180&increment=0", white.clerkId);
    const mb = await open("/matchmaking?time=180&increment=0", black.clerkId);
    const found = await mw.next("match_found");
    await mb.next("match_found");
    const started = await n.next("active_game");
    assert.equal(started.data.gameId, found.data.gameId);

    const { w } = await joinGame(found.data.gameId);
    w.send({ type: "resign" });
    const ended = await n.next("active_game");
    assert.equal(ended.data.gameId, null);
  });

  test("the session token goes in the subprotocol, never the URL", async () => {
    const refused = (url: string, protocols?: string[]) =>
      new Promise<number>((resolve) => {
        const ws = new WebSocket(url, protocols);
        ws.on("unexpected-response", (_req, res) => resolve(res.statusCode ?? 0));
        ws.on("open", () => {
          ws.close();
          resolve(101);
        });
        ws.on("error", () => {});
      });
    const base = `ws://${baseUrl}/api/ws/notifications`;
    assert.equal(await refused(`${base}?token=${white.clerkId}`), 401);
    assert.equal(await refused(base, ["gambitio"]), 401);
    assert.equal(await refused(base, ["gambitio", "auth.clerk_nobody"]), 403);
    assert.equal(await refused(base, ["gambitio", `auth.${white.clerkId}`]), 101);

    const ok = await open("/notifications", white.clerkId);
    // The server answers with the shared protocol name, not the token
    assert.equal(ok.ws.protocol, "gambitio");
  });

  test("a socket that stops re-authenticating is closed; one that does stays", async () => {
    const original = { ...reauthTimings };
    reauthTimings.validForMs = 300;
    reauthTimings.checkEveryMs = 50;
    reauthTimings.minIntervalMs = 0;
    try {
      const lapsing = await open("/notifications", white.clerkId);
      const kept = await open("/notifications", black.clerkId);
      const lapsed = closed(lapsing.ws);
      const refresh = setInterval(() => kept.send({ type: "auth", token: black.clerkId }), 100);
      try {
        assert.equal(await lapsed, 4001);
        await new Promise((r) => setTimeout(r, 400));
        assert.equal(kept.ws.readyState, WebSocket.OPEN);
      } finally {
        clearInterval(refresh);
      }
      // Someone else's token can't take a socket over
      const hijacked = closed(kept.ws);
      kept.send({ type: "auth", token: white.clerkId });
      assert.equal(await hijacked, 4001);
    } finally {
      Object.assign(reauthTimings, original);
    }
  });

  test("deleting an account closes its sockets", async () => {
    const n = await open("/notifications", white.clerkId);
    const gone = closed(n.ws);
    const res = await app.inject({
      method: "DELETE",
      url: "/api/users/me",
      headers: { authorization: `Bearer ${white.clerkId}` },
    });
    assert.equal(res.statusCode, 204);
    assert.equal(await gone, 4001);
  });

  test("two users requesting each other at the same moment make one request", async () => {
    const send = (from: { clerkId: string }, to: { id: number }) =>
      app.inject({
        method: "POST",
        url: "/api/friend-requests",
        headers: { authorization: `Bearer ${from.clerkId}` },
        payload: { receiverId: to.id },
      });
    for (let round = 0; round < 5; round++) {
      await app.pg.query(`DELETE FROM friend_requests`);
      const results = await Promise.all([send(white, black), send(black, white)]);
      const codes = results.map((r) => r.statusCode).sort();
      assert.equal(codes.filter((c) => c === 201).length, 1, JSON.stringify(codes));
      const { rows } = await app.pg.query(`SELECT count(*)::int AS n FROM friend_requests`);
      assert.equal(rows[0].n, 1);
    }
  });

  test("friend requests: accept, decline and cancel check who may act", async () => {
    const send = await app.inject({
      method: "POST",
      url: "/api/friend-requests",
      headers: { authorization: `Bearer ${white.clerkId}` },
      payload: { receiverId: black.id },
    });
    assert.equal(send.statusCode, 201, send.body);
    const id = send.json().data.id;
    const act = (clerkId: string, method: "GET" | "POST" | "DELETE", url: string) =>
      app.inject({ method, url, headers: { authorization: `Bearer ${clerkId}` } });
    // The sender can't accept or decline; the receiver can't cancel
    assert.equal((await act(white.clerkId, "POST", `/api/friend-requests/${id}/accept`)).statusCode, 403);
    assert.equal((await act(white.clerkId, "POST", `/api/friend-requests/${id}/decline`)).statusCode, 403);
    assert.equal((await act(black.clerkId, "DELETE", `/api/friend-requests/${id}`)).statusCode, 403);
    assert.equal((await act(black.clerkId, "POST", `/api/friend-requests/999999/accept`)).statusCode, 404);
    const accepted = await act(black.clerkId, "POST", `/api/friend-requests/${id}/accept`);
    assert.equal(accepted.statusCode, 200, accepted.body);
    // Now friends: the profile counts it, and the friends list finds it
    const profile = await act(white.clerkId, "GET", `/api/users/${white.id}`);
    assert.equal(profile.json().user.friendCount, 1);
    const friends = await act(white.clerkId, "GET", `/api/users/${white.id}/friends`);
    assert.deepEqual(friends.json().data.map((f: { id: number }) => f.id), [black.id]);
    // Sending again is refused
    const again = await app.inject({
      method: "POST",
      url: "/api/friend-requests",
      headers: { authorization: `Bearer ${black.clerkId}` },
      payload: { receiverId: white.id },
    });
    assert.equal(again.statusCode, 400);
  });

  test("settings update in one statement, creating the row if missing", async () => {
    const patch = (body: object) =>
      app.inject({
        method: "PATCH",
        url: "/api/settings",
        headers: { authorization: `Bearer ${white.clerkId}` },
        payload: body,
      });
    const res = await patch({ soundsEnabled: false });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(res.json().data.soundsEnabled, false);
    assert.equal(res.json().data.boardCoordinatesEnabled, true);
    assert.equal((await patch({ boardCoordinatesEnabled: false })).json().data.soundsEnabled, false);
  });

  test("the colour palette defaults to emerald and only takes known palettes", async () => {
    const patch = (body: object) =>
      app.inject({
        method: "PATCH",
        url: "/api/settings",
        headers: { authorization: `Bearer ${white.clerkId}` },
        payload: body,
      });
    const first = await patch({ soundsEnabled: true });
    assert.equal(first.json().data.colorPalette, "emerald");
    const changed = await patch({ colorPalette: "midnight" });
    assert.equal(changed.statusCode, 200, changed.body);
    assert.equal(changed.json().data.colorPalette, "midnight");
    // Every palette the API accepts is one the database accepts too
    for (const colorPalette of COLOR_PALETTES) {
      const res = await patch({ colorPalette });
      assert.equal(res.statusCode, 200, res.body);
      assert.equal(res.json().data.colorPalette, colorPalette);
    }
    await patch({ colorPalette: "midnight" });
    assert.equal((await patch({ colorPalette: "neon" })).statusCode, 400);
    const res = await app.inject({
      method: "GET",
      url: "/api/settings",
      headers: { authorization: `Bearer ${white.clerkId}` },
    });
    assert.equal(res.json().data.colorPalette, "midnight");
  });

  test("game history pages in order without pgn, with a correct total", async () => {
    const ids: number[] = [];
    for (let i = 0; i < 7; i++) {
      const [w, b] = i % 2 === 0 ? [white.id, black.id] : [black.id, white.id];
      const game = await app.pg.transact((tx) => createGame(tx, { whiteId: w, blackId: b, time: 180, increment: 0 }));
      await app.pg.query(
        `UPDATE games SET status = 'finished', result = 'draw', "createdAt" = now() - make_interval(mins => $2) WHERE id = $1`,
        [game.id, i]
      );
      ids.push(game.id);
    }
    // An aborted game is left out
    const aborted = await app.pg.transact((tx) =>
      createGame(tx, { whiteId: white.id, blackId: black.id, time: 180, increment: 0 })
    );
    await app.pg.query(`UPDATE games SET status = 'finished', result = 'aborted' WHERE id = $1`, [aborted.id]);

    const page = async (n: number) =>
      (
        await app.inject({
          url: `/api/users/${white.id}/games?page=${n}&limit=3`,
          headers: { authorization: `Bearer ${white.clerkId}` },
        })
      ).json();
    const pages = [await page(1), await page(2), await page(3)];
    assert.deepEqual(
      pages.flatMap((p) => p.data.map((g: { id: number }) => g.id)),
      ids // newest first: i = 0 is the newest
    );
    assert.equal(pages[0].pagination.total, 7);
    assert.equal(pages[0].pagination.totalPages, 3);
    assert.equal(pages[0].data[0].pgn, undefined);
    assert.equal(pages[0].data[0].fen, undefined);
  });

  test("stats still load when Redis is down", async () => {
    const original = app.redis.hGet.bind(app.redis);
    (app.redis as unknown as { hGet: unknown }).hGet = async () => {
      throw new Error("Redis is down");
    };
    try {
      const res = await app.inject({
        url: `/api/users/${white.id}/stats/summary`,
        headers: { authorization: `Bearer ${white.clerkId}` },
      });
      assert.equal(res.statusCode, 200, res.body);
      assert.equal(res.json().numberOfGames, 0);
    } finally {
      (app.redis as unknown as { hGet: unknown }).hGet = original;
    }
  });

  test("presence ignores sockets of an instance that has gone away", async () => {
    class FakeSocket extends EventEmitter {
      readonly OPEN = 1;
      readyState = 1;
      ping() {}
      terminate() {}
      send() {}
      close() {
        this.emit("close");
      }
    }
    const a = new RealtimeHub(app.redis, app.log);
    const b = new RealtimeHub(app.redis, app.log);
    await a.start();
    await b.start();
    try {
      const socket = new FakeSocket() as unknown as WebSocket;
      await a.attach(socket, { userId: 4242, topics: [], presence: "notifications" });
      // Seen from the other instance, through Redis
      assert.equal(await b.isPresent("notifications", 4242), true);
      // a crashes: its liveness key expires (simulated by deleting it)
      await app.redis.del(`instance:${a.instanceId}`);
      assert.equal(await b.isPresent("notifications", 4242), false);
      // ...and its stale member was cleaned up
      assert.equal(await app.redis.zCard("presence:notifications:4242"), 0);
    } finally {
      await a.stop();
      await b.stop();
    }
  });

  test("a resignation or draw offer after the flag fell ends the game on time", async () => {
    const game = await newGame();
    const { w, b } = await joinGame(game.id);
    for (const [socket, uci] of [
      [w, "e2e4"],
      [b, "e7e5"],
    ] as const) {
      socket.send(move(uci));
      await w.next("move", (m) => m.move.lan === uci);
    }
    // White's flag has fallen; black resigns before the deadline timer fires
    await app.pg.query(
      `UPDATE games SET "whiteTimeLeftMs" = 0, "deadlineAt" = now() - interval '1 second' WHERE id = $1`,
      [game.id]
    );
    b.send({ type: "resign" });
    const ended = await w.next("game_ended");
    assert.equal(ended.reason, "timeout");
    assert.equal(ended.winnerId, black.id);
  });

  test("a move that ends the game leaves no deadline timer behind", async () => {
    await app.liveGames.startDeadlineTimers();
    const game = await newGame();
    const { w, b } = await joinGame(game.id);
    for (const [socket, uci] of [
      [w, "f2f3"],
      [b, "e7e5"],
      [w, "g2g4"],
      [b, "d8h4"],
    ] as const) {
      socket.send(move(uci));
      await w.next("move", (m) => m.move.lan === uci);
    }
    assert.equal((await w.next("game_ended")).reason, "checkmate");
    assert.equal(app.liveGames.watchedGameCount, 0);
  });

  test("accepting a challenge while matchmaking pairs the challenger doesn't deadlock", async () => {
    const other = await createUser(app, "other");
    await app.pg.query(`INSERT INTO friends ("userOneId", "userTwoId") VALUES ($1, $2)`, [white.id, black.id]);
    const nw = await open("/notifications", white.clerkId);
    const nb = await open("/notifications", black.clerkId);
    await new Promise((r) => setTimeout(r, 100));
    nw.send({ type: "challenge_sent", data: { challengedId: black.id, color: "white", time: 300, increment: 0 } });
    await nb.next("challenge_received");
    await app.pg.query(
      `INSERT INTO matchmaking ("userId", rating, time, increment) VALUES ($1, 1200, 60, 0), ($2, 1200, 60, 0)`,
      [white.id, other.id]
    );

    // A pairing of white with someone else, caught between locking the queue
    // rows and the players' rows (see MatchmakingService.tryMatch)
    const pairing = await app.pg.connect();
    try {
      await pairing.query("BEGIN");
      await pairing.query(`SELECT id FROM matchmaking WHERE "userId" = ANY($1) FOR UPDATE`, [[white.id, other.id]]);
      const accepted = app.challenges.accept(black.id, white.id);
      await new Promise((r) => setTimeout(r, 200));
      await pairing.query(`SELECT 1 FROM users WHERE id = ANY($1) ORDER BY id FOR UPDATE`, [[white.id, other.id]]);
      await pairing.query("COMMIT");
      await accepted;
    } finally {
      pairing.release();
    }
    const { rows } = await app.pg.query(`SELECT count(*)::int AS n FROM games`);
    assert.equal(rows[0].n, 1);
  });

  test("ids too large for the database are rejected, not a server error", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/games/99999999999",
      headers: { authorization: `Bearer ${white.clerkId}` },
    });
    assert.ok(res.statusCode >= 400 && res.statusCode < 500, `status ${res.statusCode}`);
    const n = await open("/notifications", white.clerkId);
    n.send({ type: "challenge_accepted", data: { challengerId: 99999999999 } });
    assert.equal((await n.next("error")).data.code, "INVALID_MESSAGE");
  });

  test("the rate-limit key reads a token's subject without trusting it", () => {
    const jwt = (payload: object) =>
      `x.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.sig`;
    assert.equal(unverifiedSubject({ headers: { authorization: `Bearer ${jwt({ sub: "user_1" })}` } }), "user_1");
    assert.equal(
      unverifiedSubject({ headers: { "sec-websocket-protocol": `gambitio, auth.${jwt({ sub: "user_2" })}` } }),
      "user_2"
    );
    assert.equal(unverifiedSubject({ headers: { authorization: "Bearer not-a-jwt" } }), null);
    assert.equal(unverifiedSubject({ headers: {} }), null);
  });
});
