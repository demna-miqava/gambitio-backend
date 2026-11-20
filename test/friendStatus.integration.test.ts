import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { FastifyInstance } from "fastify";
import type WebSocket from "ws";
import { connect, createUser, integrationEnabled, resetDb, startTestApp, type TestSocket } from "./helpers.js";
import { createGame } from "../src/services/gameService.js";
import { RealtimeHub } from "../src/realtime/hub.js";
import { FriendRepository } from "../src/repositories/friendRepository.js";
import { FRIEND_STATUS_LIMIT } from "../src/services/friendService.js";

describe("friends online and in game", { skip: !integrationEnabled && "TEST_POSTGRES_URL / TEST_REDIS_URL not set" }, () => {
  let app: FastifyInstance;
  let baseUrl: string;
  const sockets: TestSocket[] = [];

  const befriend = (a: number, b: number) =>
    app.pg.query(`INSERT INTO friends ("userOneId", "userTwoId") VALUES ($1, $2)`, [a, b]);
  const statuses = async (clerkId: string) => {
    const res = await app.inject({
      method: "GET",
      url: "/api/friends/status",
      headers: { authorization: `Bearer ${clerkId}` },
    });
    assert.equal(res.statusCode, 200, res.body);
    return res.json().data as Array<{ id: number; status: string; gameId: number | null; gameType: string | null }>;
  };
  const online = async (clerkId: string) => {
    const socket = await connect(baseUrl, "/notifications", clerkId);
    sockets.push(socket);
    return socket;
  };
  const until = async (check: () => Promise<boolean>) => {
    for (let i = 0; i < 50; i++) {
      if (await check()) return;
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.fail("condition never became true");
  };

  before(async () => {
    ({ app, baseUrl } = await startTestApp());
  });
  after(async () => {
    await Promise.all(sockets.splice(0).map((s) => s.close()));
    await app.close();
  });
  beforeEach(async () => {
    await Promise.all(sockets.splice(0).map((s) => s.close()));
    await resetDb(app);
  });

  test("lists friends who are online or playing, available ones first", async () => {
    const me = await createUser(app, "myself");
    const zed = await createUser(app, "zelda"); // friend, online
    const amy = await createUser(app, "amelia"); // friend, playing (tab closed)
    const bob = await createUser(app, "bobby"); // friend, offline
    const stranger = await createUser(app, "stranger"); // online, not a friend
    for (const friend of [zed, amy, bob]) await befriend(me.id, friend.id);
    await befriend(stranger.id, zed.id);

    await online(zed.clerkId);
    await online(stranger.clerkId);
    const game = await app.pg.transact((tx) =>
      createGame(tx, { whiteId: amy.id, blackId: stranger.id, time: 180, increment: 2 })
    );

    assert.deepEqual(
      (await statuses(me.clerkId)).map((s) => [s.id, s.status, s.gameId, s.gameType]),
      [
        // Online and free comes before playing, though "amelia" sorts first
        [zed.id, "online", null, null],
        [amy.id, "playing", game.id, "blitz"],
      ]
    );
    // The same fields as the friends list, so the client can show them alike
    const [zelda] = await statuses(me.clerkId);
    assert.deepEqual(
      Object.keys(zelda!).sort(),
      ["avatarUrl", "blitzRating", "bulletRating", "friendsSince", "gameId", "gameType", "id", "rapidRating", "status", "username"]
    );
    // Nobody's friends with bob or me online: an empty list, not an error
    assert.deepEqual(await statuses(bob.clerkId), []);
  });

  test("only the first friends in the friends list's order are looked at, with their games", async () => {
    const me = await createUser(app, "myself");
    const cara = await createUser(app, "cara");
    const abe = await createUser(app, "abe");
    const bea = await createUser(app, "bea");
    for (const friend of [cara, abe, bea]) await befriend(me.id, friend.id);
    const game = await app.pg.transact((tx) => createGame(tx, { whiteId: bea.id, blackId: cara.id, time: 60, increment: 0 }));

    const first = await new FriendRepository(app).getFriendsWithLiveGame(me.id, 2);
    assert.deepEqual(
      first.map((f) => [f.username, f.gameId]),
      [
        ["abe", null],
        ["bea", game.id],
      ]
    );
    // The endpoint has a limit of its own, far above this
    assert.ok(FRIEND_STATUS_LIMIT >= 100);
    assert.deepEqual(
      (await statuses(me.clerkId)).map((s) => s.id),
      [bea.id, cara.id]
    );
  });

  test("a friend who closes their last tab drops off the list", async () => {
    const me = await createUser(app, "myself");
    const friend = await createUser(app, "friend");
    await befriend(friend.id, me.id);

    const first = await online(friend.clerkId);
    const second = await online(friend.clerkId);
    assert.equal((await statuses(me.clerkId)).length, 1);

    await first.close();
    // Still one tab open
    await until(async () => app.hub.localCount(`notifications:user:${friend.id}`) === 1);
    assert.equal((await statuses(me.clerkId)).length, 1);

    await second.close();
    await until(async () => (await statuses(me.clerkId)).length === 0);
  });

  test("requires signing in", async () => {
    const res = await app.inject({ method: "GET", url: "/api/friends/status" });
    assert.equal(res.statusCode, 401);
  });

  describe("friends as opponents", () => {
    type Opponent = {
      id: number;
      username: string;
      status: string | null;
      gameId: number | null;
      gameType: string | null;
      lastPlayedAt: string | null;
    };
    const opponents = async (clerkId: string, query = "") => {
      const res = await app.inject({
        method: "GET",
        url: `/api/friends/opponents${query}`,
        headers: { authorization: `Bearer ${clerkId}` },
      });
      assert.equal(res.statusCode, 200, res.body);
      return res.json() as { data: Opponent[]; pagination: { page: number; limit: number; total: number; totalPages: number } };
    };
    /** A finished game between the two, started at `playedAt` */
    const played = async (whiteId: number, blackId: number, playedAt: string) => {
      const game = await app.pg.transact((tx) => createGame(tx, { whiteId, blackId, time: 300, increment: 0 }));
      await app.pg.query(
        `UPDATE games SET status = 'finished', result = 'draw', "createdAt" = $2::timestamptz WHERE id = $1`,
        [game.id, playedAt]
      );
    };

    test("online first, then playing, then most recently played, then by name", async () => {
      const me = await createUser(app, "myself");
      const abe = await createUser(app, "abe"); // never played, offline
      const bea = await createUser(app, "bea"); // played long ago
      const cal = await createUser(app, "cal"); // played last
      const dee = await createUser(app, "dee"); // in a game
      const eve = await createUser(app, "eve"); // online
      const zoe = await createUser(app, "zoe"); // never played, offline
      const stranger = await createUser(app, "stranger"); // played yesterday, not a friend
      for (const friend of [abe, bea, cal, dee, eve, zoe]) await befriend(me.id, friend.id);

      await played(me.id, bea.id, "2026-01-01T12:00:00Z");
      await played(bea.id, me.id, "2026-02-01T12:00:00Z");
      await played(cal.id, me.id, "2026-03-01T12:00:00Z");
      await played(me.id, stranger.id, "2026-04-01T12:00:00Z");
      await online(eve.clerkId);
      const live = await app.pg.transact((tx) =>
        createGame(tx, { whiteId: dee.id, blackId: stranger.id, time: 60, increment: 0 })
      );

      const { data, pagination } = await opponents(me.clerkId);
      assert.deepEqual(
        data.map((f) => [f.username, f.status, f.gameId, f.gameType, f.lastPlayedAt]),
        [
          ["eve", "online", null, null, null],
          ["dee", "playing", live.id, "bullet", null],
          ["cal", null, null, null, "2026-03-01T12:00:00.000Z"],
          // The later of the two games, whichever colour
          ["bea", null, null, null, "2026-02-01T12:00:00.000Z"],
          ["abe", null, null, null, null],
          ["zoe", null, null, null, null],
        ]
      );
      assert.deepEqual(pagination, { page: 1, limit: 10, total: 6, totalPages: 1 });
      // A friends list item, plus the status fields and when they last played
      assert.deepEqual(
        Object.keys(data[0]!).sort(),
        ["avatarUrl", "blitzRating", "bulletRating", "friendsSince", "gameId", "gameType", "id", "lastPlayedAt", "rapidRating", "status", "username"]
      );
    });

    test("pages and searches in the same order", async () => {
      const me = await createUser(app, "myself");
      const anna = await createUser(app, "anna");
      const hanna = await createUser(app, "hanna");
      const bob = await createUser(app, "bob_");
      const bobby = await createUser(app, "bobby");
      for (const friend of [anna, hanna, bob, bobby]) await befriend(friend.id, me.id);
      await played(me.id, hanna.id, "2026-03-01T12:00:00Z");
      await online(bobby.clerkId);

      const names = async (query: string) => (await opponents(me.clerkId, query)).data.map((f) => f.username);
      assert.deepEqual(await names("?limit=3"), ["bobby", "hanna", "anna"]);
      const second = await opponents(me.clerkId, "?limit=3&page=2");
      assert.deepEqual(second.data.map((f) => f.username), ["bob_"]);
      assert.deepEqual(second.pagination, { page: 2, limit: 3, total: 4, totalPages: 2 });

      assert.deepEqual(await names("?q=ANN"), ["hanna", "anna"]);
      // "_" is the character, not a wildcard
      assert.deepEqual(await names("?q=b_"), ["bob_"]);
      // An empty search is no search
      assert.equal((await names("?q=")).length, 4);
      assert.deepEqual(await names("?q=nobody"), []);
    });

    test("only your own friends, and only signed in", async () => {
      const me = await createUser(app, "myself");
      const friend = await createUser(app, "friend");
      const other = await createUser(app, "other");
      await befriend(friend.id, other.id);
      assert.deepEqual((await opponents(me.clerkId)).data, []);
      assert.deepEqual((await opponents(me.clerkId)).pagination, { page: 1, limit: 10, total: 0, totalPages: 0 });

      const res = await app.inject({ method: "GET", url: "/api/friends/opponents" });
      assert.equal(res.statusCode, 401);
      const bad = await app.inject({
        method: "GET",
        url: "/api/friends/opponents?limit=1000",
        headers: { authorization: `Bearer ${me.clerkId}` },
      });
      assert.equal(bad.statusCode, 400, bad.body);
    });
  });

  test("presentUserIds sees other instances' sockets, and not a dead instance's", async () => {
    class FakeSocket extends EventEmitter {
      readonly OPEN = 1;
      readonly CLOSED = 3;
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
      await a.attach(new FakeSocket() as unknown as WebSocket, { userId: 901, topics: [], presence: "notifications" });
      await b.attach(new FakeSocket() as unknown as WebSocket, { userId: 902, topics: [], presence: "notifications" });
      // Matchmaking presence is a different kind
      await b.attach(new FakeSocket() as unknown as WebSocket, { userId: 903, topics: [], presence: "matchmaking" });

      assert.deepEqual([...(await b.presentUserIds("notifications", [901, 902, 903, 904]))].sort(), [901, 902]);
      assert.deepEqual([...(await b.presentUserIds("notifications", []))], []);

      // a crashes: its liveness key expires (simulated by deleting it). b
      // reuses what it read for a while (REMOTE_PRESENCE_CACHE_MS), so a
      // third instance, which hasn't read it yet, is asked
      await app.redis.del(`instance:${a.instanceId}`);
      const c = new RealtimeHub(app.redis, app.log);
      assert.deepEqual([...(await c.presentUserIds("notifications", [901, 902]))], [902]);
    } finally {
      await a.stop();
      await b.stop();
    }
  });
});
