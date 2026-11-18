import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { FastifyInstance } from "fastify";
import type WebSocket from "ws";
import { connect, createUser, integrationEnabled, resetDb, startTestApp, type TestSocket } from "./helpers.js";
import { createGame } from "../src/services/gameService.js";
import { RealtimeHub } from "../src/realtime/hub.js";

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

      // a crashes: its liveness key expires (simulated by deleting it)
      await app.redis.del(`instance:${a.instanceId}`);
      assert.deepEqual([...(await b.presentUserIds("notifications", [901, 902]))], [902]);
    } finally {
      await a.stop();
      await b.stop();
    }
  });
});
