import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import http from "node:http";
import type { FastifyInstance } from "fastify";
import WebSocket from "ws";
import { connect, createUser, fakeAuth, integrationEnabled, resetDb, startTestApp, type TestSocket } from "./helpers.js";
import { createGame } from "../src/services/gameService.js";
import { RealtimeHub } from "../src/realtime/hub.js";
import { userBucketCount } from "../src/realtime/socket.js";
import { MAX_SOCKETS_PER_USER } from "../src/middleware/wsAuth.js";
import { accountDeletion } from "../src/services/userService.js";

/*
 * Rate limits and resource bounds: the per-user WebSocket bucket, the socket
 * cap under concurrent handshakes, the profile-sync route, account deletion
 * in batches, and the hub skipping Redis while it is alone.
 */
describe("limits", { skip: !integrationEnabled && "TEST_POSTGRES_URL / TEST_REDIS_URL not set" }, () => {
  let app: FastifyInstance;
  let baseUrl: string;
  const sockets: TestSocket[] = [];

  before(async () => {
    ({ app, baseUrl } = await startTestApp());
  });
  after(async () => {
    await app.close();
  });
  beforeEach(async () => {
    await Promise.all(sockets.splice(0).map((s) => s.close()));
    await resetDb(app);
  });

  const open = async (path: string, clerkId: string) => {
    const socket = await connect(baseUrl, path, clerkId);
    sockets.push(socket);
    return socket;
  };
  const settle = (ms = 150) => new Promise((r) => setTimeout(r, ms));
  const errorsOf = (s: TestSocket, code: string) =>
    s.messages.filter((m) => m.type === "error" && m.data.code === code).length;

  test("one user's sockets share a message budget, and game sockets keep a reserve", async () => {
    const user = await createUser(app, "flooder");
    const other = await createUser(app, "partner");
    const game = await app.pg.transact((tx) =>
      createGame(tx, { whiteId: user.id, blackId: other.id, time: 60, increment: 0 })
    );
    const notifications = await Promise.all([1, 2, 3, 4].map(() => open("/notifications", user.clerkId)));
    const g = await open(`/game/${game.id}`, user.clerkId);
    await g.next("initial_game_state");

    // 4 × 15 messages: each socket stays inside its own burst of 20, but
    // together they go past what the user's other sockets may use (60 - 20)
    for (const n of notifications) for (let i = 0; i < 15; i++) n.send({ type: "nonsense" });
    await settle();
    const limited = notifications.reduce((sum, n) => sum + errorsOf(n, "RATE_LIMITED"), 0);
    const handled = notifications.reduce((sum, n) => sum + errorsOf(n, "INVALID_MESSAGE"), 0);
    assert.equal(limited + handled, 60);
    assert.ok(handled >= 40 && handled <= 46, `handled ${handled}`);
    // The dropped message is named, as before
    const dropped = notifications.flatMap((n) => n.messages).find((m) => m.data?.code === "RATE_LIMITED");
    assert.deepEqual(dropped.data.request, { type: "nonsense" });

    // The game socket still gets through on the reserve
    g.send({ type: "sync" });
    await g.next("initial_game_state");
    assert.equal(errorsOf(g, "RATE_LIMITED"), 0);

    // Another user isn't affected
    const bystander = await open("/notifications", other.clerkId);
    bystander.send({ type: "nonsense" });
    assert.equal((await bystander.next("error")).data.code, "INVALID_MESSAGE");

    // The shared bucket goes when the user's last socket does
    const before = userBucketCount();
    await Promise.all([...notifications, g].map((s) => s.close()));
    await settle();
    assert.equal(userBucketCount(), before - 1);
  });

  test("auth messages are parsed once and still refresh the session", async () => {
    const user = await createUser(app, "refresher");
    const n = await open("/notifications", user.clerkId);
    n.send({ type: "auth", token: user.clerkId });
    n.send({ type: "nonsense" });
    assert.equal((await n.next("error")).data.code, "INVALID_MESSAGE");
    // A token for someone else closes the socket
    await settle(1_100); // re-authentication is throttled to one per second
    const closed = new Promise<number>((resolve) => n.ws.once("close", (code) => resolve(code)));
    n.send({ type: "auth", token: "clerk_someone_else" });
    assert.equal(await closed, 4001);
  });

  test("plain GET and HEAD requests to a socket route don't take socket slots", async () => {
    const user = await createUser(app, "plainhttp");
    // One kept-alive connection, as a browser or proxy would hold it
    const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
    const [host, port] = baseUrl.split(":");
    const request = (method: string) =>
      new Promise<number>((resolve, reject) => {
        const req = http.request(
          {
            host,
            port: Number(port),
            method,
            path: "/api/ws/notifications",
            agent,
            headers: { "sec-websocket-protocol": `gambitio, auth.${user.clerkId}` },
          },
          (res) => {
            res.resume();
            res.on("end", () => resolve(res.statusCode ?? 0));
          }
        );
        req.on("error", reject);
        req.end();
      });
    try {
      const statuses = [];
      for (let i = 0; i < MAX_SOCKETS_PER_USER + 3; i++) statuses.push(await request(i % 2 ? "HEAD" : "GET"));
      assert.ok(statuses.every((s) => s !== 101 && s !== 429), `no upgrade, never refused: ${statuses}`);
      assert.equal(app.hub.userConnectionCount(user.id), 0, "no slot held while the connection stays open");
      const socket = await open("/notifications", user.clerkId);
      assert.equal(socket.ws.readyState, WebSocket.OPEN);
    } finally {
      agent.destroy();
    }
  });

  test("simultaneous handshakes can't open more than the socket cap", async () => {
    const user = await createUser(app, "tabhoarder");
    const attempts = Array.from({ length: MAX_SOCKETS_PER_USER + 8 }, () => {
      const ws = new WebSocket(`ws://${baseUrl}/api/ws/notifications`, ["gambitio", `auth.${user.clerkId}`]);
      return new Promise<{ ws: WebSocket; status: number }>((resolve) => {
        ws.once("open", () => resolve({ ws, status: 101 }));
        ws.once("unexpected-response", (_req, res) => resolve({ ws, status: res.statusCode ?? 0 }));
        ws.once("error", () => resolve({ ws, status: 0 }));
      });
    });
    const results = await Promise.all(attempts);
    const opened = results.filter((r) => r.status === 101);
    assert.equal(opened.length, MAX_SOCKETS_PER_USER);
    assert.ok(results.filter((r) => r.status !== 101).every((r) => r.status === 429));
    assert.equal(app.hub.userConnectionCount(user.id), MAX_SOCKETS_PER_USER);

    // Slots come back when sockets close, including refused and failed ones
    await Promise.all(
      results.map(
        ({ ws }) =>
          new Promise<void>((resolve) => {
            if (ws.readyState === WebSocket.CLOSED) return resolve();
            ws.once("close", () => resolve());
            ws.terminate();
          })
      )
    );
    await settle();
    assert.equal(app.hub.userConnectionCount(user.id), 0);
    const again = await open("/notifications", user.clerkId);
    assert.equal(again.ws.readyState, WebSocket.OPEN);
  });

  test("a socket the route closes before attaching gives its slot back", async () => {
    const user = await createUser(app, "badlink");
    const ws = new WebSocket(`ws://${baseUrl}/api/ws/game/notanumber`, ["gambitio", `auth.${user.clerkId}`]);
    await new Promise((resolve) => ws.once("close", resolve));
    await settle();
    assert.equal(app.hub.userConnectionCount(user.id), 0);
  });

  test("profile sync asks Clerk only for a new profile, and is limited per Clerk user", async () => {
    const calls: string[] = [];
    const original = fakeAuth.getEmail;
    fakeAuth.getEmail = async (clerkId) => {
      calls.push(clerkId);
      return `${clerkId}@test.local`;
    };
    try {
      const sync = (clerkId: string, username: string) =>
        app.inject({
          method: "POST",
          url: "/api/users/sync",
          headers: { authorization: `Bearer ${clerkId}` },
          payload: { username, skill: "beginner" },
        });
      const existing = await createUser(app, "already");
      assert.equal((await sync(existing.clerkId, "already")).statusCode, 201);
      assert.deepEqual(calls, [], "an existing profile needs no Clerk call");

      assert.equal((await sync("clerk_newcomer", "Already")).json().code, "USERNAME_TAKEN");
      assert.deepEqual(calls, [], "a taken name needs no Clerk call");

      const created = await sync("clerk_newcomer", "newcomer");
      assert.equal(created.statusCode, 201);
      assert.equal(created.json().user.username, "newcomer");
      assert.deepEqual(calls, ["clerk_newcomer"]);

      // 10 per minute per Clerk user (2 used by clerk_newcomer so far)
      const statuses = [];
      for (let i = 0; i < 9; i++) statuses.push((await sync("clerk_newcomer", "newcomer")).statusCode);
      assert.deepEqual(statuses, [201, 201, 201, 201, 201, 201, 201, 201, 429]);
      assert.deepEqual(calls, ["clerk_newcomer"], "repeats never reached Clerk");
      // Counted per verified Clerk user, not per address
      assert.equal((await sync("clerk_someone", "someone")).statusCode, 201);
    } finally {
      fakeAuth.getEmail = original;
    }
  });

  test("account deletion rewrites a long history in batches, and a failed attempt can be finished", async () => {
    const original = accountDeletion.batchSize;
    accountDeletion.batchSize = 3;
    try {
      const leaver = await createUser(app, "leaver");
      const stayer = await createUser(app, "stayer");
      await app.pg.query(`UPDATE users SET "avatarUrl" = 'https://img.test/a.png' WHERE id = $1`, [leaver.id]);
      for (let i = 0; i < 11; i++) {
        const [w, b] = i % 3 === 0 ? [stayer.id, leaver.id] : [leaver.id, stayer.id];
        const game = await app.pg.transact((tx) => createGame(tx, { whiteId: w, blackId: b, time: 60, increment: 0 }));
        // Several share a timestamp, so batches end between equal ones
        await app.pg.query(
          `UPDATE games SET status = 'finished', result = 'draw',
             "createdAt" = timestamp '2026-01-01' + make_interval(mins => $2),
             "whiteAvatarUrl" = 'https://img.test/a.png', "blackAvatarUrl" = 'https://img.test/a.png'
           WHERE id = $1`,
          [game.id, Math.floor(i / 2)]
        );
      }
      await app.pg.query(
        `INSERT INTO push_subscriptions ("userId", endpoint, p256dh, auth)
         VALUES ($1, 'https://fcm.googleapis.com/fcm/send/x', 'p', 'a')`,
        [leaver.id]
      );

      // The first attempt fails after the batches (in the final
      // transaction, the second one)
      const transact = app.pg.transact.bind(app.pg);
      let calls = 0;
      (app.pg as { transact: unknown }).transact = (fn: never) => {
        if (++calls === 2) return Promise.reject(new Error("database went away"));
        return transact(fn);
      };
      const remove = () =>
        app.inject({ method: "DELETE", url: "/api/users/me", headers: { authorization: `Bearer ${leaver.clerkId}` } });
      try {
        assert.equal((await remove()).statusCode, 500);
        // Still findable by its Clerk id, so the retry can finish the job
        const { rows } = await app.pg.query(`SELECT "clerkId" FROM users WHERE id = $1`, [leaver.id]);
        assert.equal(rows[0].clerkId, leaver.clerkId);
        assert.equal((await remove()).statusCode, 204);
      } finally {
        (app.pg as { transact: unknown }).transact = transact;
      }

      const { rows: games } = await app.pg.query(
        `SELECT "whiteId", "whiteUsername", "whiteAvatarUrl", "blackId", "blackUsername", "blackAvatarUrl" FROM games`
      );
      assert.equal(games.length, 11);
      for (const g of games) {
        const side = g.whiteId === leaver.id ? "white" : "black";
        assert.equal(g[`${side}Username`], `deleted-${leaver.id}`);
        assert.equal(g[`${side}AvatarUrl`], null);
        const opponent = side === "white" ? "black" : "white";
        assert.equal(g[`${opponent}Username`], "stayer");
      }
      const { rows: subs } = await app.pg.query(`SELECT 1 FROM push_subscriptions WHERE "userId" = $1`, [leaver.id]);
      assert.equal(subs.length, 0);
    } finally {
      accountDeletion.batchSize = original;
    }
  });

  describe("hub", () => {
    class FakeSocket extends EventEmitter {
      readonly OPEN = 1;
      readyState = 1;
      sent: string[] = [];
      ping() {}
      terminate() {}
      send(payload: string) {
        this.sent.push(payload);
      }
      close() {
        this.readyState = 3;
        this.emit("close");
      }
    }
    const until = async (check: () => boolean, ms = 2_000) => {
      const end = Date.now() + ms;
      while (!check()) {
        if (Date.now() > end) throw new Error("timed out");
        await new Promise((r) => setTimeout(r, 10));
      }
    };

    test("alone, it delivers locally and skips Redis; a new instance is heard at once", async () => {
      const publishes: string[] = [];
      const redisPublish = app.redis.publish.bind(app.redis);
      (app.redis as { publish: unknown }).publish = (channel: string, raw: string) => {
        publishes.push(raw);
        return redisPublish(channel, raw);
      };
      const a = new RealtimeHub(app.redis, app.log);
      let b: RealtimeHub | null = null;
      try {
        await a.start();
        // Pretend a has run alone for a while: its startup grace is over
        (a as unknown as { othersSeenAt: number }).othersSeenAt = 0;
        assert.equal(a.othersAlive, false);
        const local = new FakeSocket();
        await a.attach(local as unknown as WebSocket, { userId: 1, topics: ["t:1"] });
        publishes.length = 0;
        const message = { type: "move", data: { lan: "e2e4", note: 'quote " and \\ backslash' } };
        await a.publish("t:1", message);
        assert.deepEqual(local.sent, [JSON.stringify(message)]);
        assert.deepEqual(publishes, [], "nothing went to Redis");

        // A second instance starts: its announcement switches a back on
        b = new RealtimeHub(app.redis, app.log);
        await b.start();
        await until(() => a.othersAlive);
        assert.equal(b.othersAlive, true);
        const remote = new FakeSocket();
        await b.attach(remote as unknown as WebSocket, { userId: 2, topics: ["t:1"] });
        publishes.length = 0;
        // Not awaited one by one: the order still holds
        void a.publish("t:1", { n: 1 });
        void a.publish("t:1", { n: 2 });
        await a.publish("t:1", message);
        await until(() => remote.sent.length === 3);
        assert.deepEqual(remote.sent, [JSON.stringify({ n: 1 }), JSON.stringify({ n: 2 }), JSON.stringify(message)]);
        // The envelope is exactly what JSON.stringify would have written
        assert.equal(publishes[2], JSON.stringify({ origin: a.instanceId, topic: "t:1", message }));
        // Our own echoes aren't delivered twice
        assert.equal(local.sent.length, 4);

        // Other envelopes still cross
        await a.closeTopicSockets("t:1");
        await until(() => remote.readyState === 3);
      } finally {
        (app.redis as { publish: unknown }).publish = redisPublish;
        await a.stop();
        await b?.stop();
      }
    });

    test("while its own subscriber is down, one receiver means another instance is listening", async () => {
      // The test app's own hub is the one other instance subscribed
      const a = new RealtimeHub(app.redis, app.log);
      const internals = a as unknown as {
        sub: { isReady: boolean; disconnect(): Promise<void> } | null;
        othersSeenAt: number;
        announce(): Promise<void>;
      };
      try {
        await a.start();
        // a's subscriber drops (Redis restarting, a network blip), and a's
        // startup grace is over
        const sub = internals.sub!;
        await sub.disconnect();
        assert.equal(sub.isReady, false);
        internals.othersSeenAt = 0;
        assert.equal(a.othersAlive, false);
        // a's next heartbeat reaches one receiver: the other instance, not itself
        await internals.announce();
        assert.equal(a.othersAlive, true, "the other instance is still published to");
      } finally {
        internals.sub = null; // already closed
        await a.stop();
      }
    });

    test("a publish nobody awaits doesn't become an unhandled rejection", async () => {
      const a = new RealtimeHub(app.redis, app.log);
      await a.start();
      const redisPublish = app.redis.publish.bind(app.redis);
      (app.redis as { publish: unknown }).publish = () => Promise.reject(new Error("redis down"));
      const unhandled: unknown[] = [];
      const onUnhandled = (reason: unknown) => unhandled.push(reason);
      process.on("unhandledRejection", onUnhandled);
      try {
        assert.equal(a.othersAlive, true, "within its startup grace");
        void a.publish("t:2", { x: 1 });
        await assert.rejects(a.publish("t:2", { x: 2 }), /redis down/);
        await new Promise((r) => setTimeout(r, 50));
        assert.deepEqual(unhandled, []);
      } finally {
        process.off("unhandledRejection", onUnhandled);
        (app.redis as { publish: unknown }).publish = redisPublish;
        await a.stop();
      }
    });
  });
});
