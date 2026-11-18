import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import type { FastifyInstance } from "fastify";
import { connect, createUser, integrationEnabled, resetDb, startTestApp, type TestSocket } from "./helpers.js";
import https from "node:https";
import webpush from "web-push";
import {
  isPushServiceEndpoint,
  PUSH_LIMITS,
  timeControlLabel,
  webPushSender,
  type StoredSubscription,
} from "../src/services/pushService.js";
import { loadConfig, vapidKeys } from "../src/config.js";

describe("push endpoints", () => {
  test("only the browsers' push services are accepted", () => {
    for (const endpoint of [
      "https://fcm.googleapis.com/fcm/send/abc123",
      "https://updates.push.services.mozilla.com/wpush/v2/abc",
      "https://wns2-par02p.notify.windows.com/w/?token=abc",
      "https://web.push.apple.com/abc",
    ]) {
      assert.equal(isPushServiceEndpoint(endpoint), true, endpoint);
    }
    for (const endpoint of [
      "http://fcm.googleapis.com/fcm/send/abc", // not https
      "https://localhost/x",
      "https://127.0.0.1/x",
      "https://169.254.169.254/latest/meta-data",
      "https://fcm.googleapis.com.evil.example/x",
      "https://evil.example/fcm.googleapis.com",
      "https://notify.windows.com.evil.example/x",
      "https://evilpush.apple.com/x",
      "https://user:pass@fcm.googleapis.com/x",
      "https://fcm.googleapis.com:8443/x",
      "file:///etc/passwd",
      "not a url",
      "",
    ]) {
      assert.equal(isPushServiceEndpoint(endpoint), false, endpoint);
    }
  });

  test("time controls read like the app's", () => {
    assert.equal(timeControlLabel(300, 0), "5+0");
    assert.equal(timeControlLabel(180, 2), "3+2");
    assert.equal(timeControlLabel(30, 0), "0.5+0");
  });

  test("notifications go out over kept-alive connections", async () => {
    const calls: any[] = [];
    const original = webpush.sendNotification;
    // No push service is contacted: the call is captured instead
    webpush.sendNotification = (async (...args: any[]) => {
      calls.push(args);
      return { statusCode: 201, body: "", headers: {} };
    }) as typeof webpush.sendNotification;
    try {
      const send = webPushSender({ subject: "mailto:x@example.com", publicKey: "pub", privateKey: "priv" });
      const subscription = { endpoint: "https://fcm.googleapis.com/fcm/send/a", p256dh: "p", auth: "a" };
      await send(subscription, "{}", 60);
      await send(subscription, "{}", 60);
    } finally {
      webpush.sendNotification = original;
    }
    const agents = calls.map((args) => args[2].agent);
    assert.ok(agents[0] instanceof https.Agent);
    assert.equal((agents[0] as https.Agent & { keepAlive: boolean }).keepAlive, true);
    // The same agent (and its open connections) for every notification
    assert.equal(agents[1], agents[0]);
  });

  test("VAPID keys come as a pair", () => {
    const base = { POSTGRES_CONNECTION_STRING: "postgres://x", CLERK_PUBLISHABLE_KEY: "pk", CLERK_SECRET_KEY: "sk" };
    assert.equal(vapidKeys(loadConfig({ ...base, VAPID_PUBLIC_KEY: "", VAPID_PRIVATE_KEY: "" })), null);
    assert.deepEqual(vapidKeys(loadConfig({ ...base, VAPID_PUBLIC_KEY: "pub", VAPID_PRIVATE_KEY: "priv" })), {
      subject: "http://localhost:5173",
      publicKey: "pub",
      privateKey: "priv",
    });
    assert.throws(() => loadConfig({ ...base, VAPID_PUBLIC_KEY: "pub" }), /set both or neither/);
    assert.throws(
      () => loadConfig({ ...base, VAPID_PUBLIC_KEY: "pub", VAPID_PRIVATE_KEY: "priv", VAPID_SUBJECT: "someone" }),
      /VAPID_SUBJECT/
    );
  });
});

describe("push notifications", { skip: !integrationEnabled && "TEST_POSTGRES_URL / TEST_REDIS_URL not set" }, () => {
  let app: FastifyInstance;
  let baseUrl: string;
  const sockets: TestSocket[] = [];
  /** What the fake push service was asked to deliver */
  const sent: { subscription: StoredSubscription; payload: any; ttl: number }[] = [];
  /** Endpoints the fake push service says are gone */
  const gone = new Set<string>();
  /** Endpoints the fake push service refuses, with this status */
  const refusing = new Map<string, number>();

  const open = async (path: string, clerkId: string) => {
    const socket = await connect(baseUrl, path, clerkId);
    sockets.push(socket);
    return socket;
  };
  const call = (method: "GET" | "POST" | "DELETE", url: string, clerkId: string, payload?: object) =>
    app.inject({
      method,
      url,
      headers: { authorization: `Bearer ${clerkId}` },
      ...(payload && { payload }),
    });
  const keys = { p256dh: "B".repeat(87), auth: "a".repeat(22) };
  const endpointFor = (name: string) => `https://fcm.googleapis.com/fcm/send/${name}`;
  const subscribe = (clerkId: string, name: string) =>
    call("POST", "/api/push/subscriptions", clerkId, { endpoint: endpointFor(name), keys });
  /** Notifications are sent without being awaited: give them a moment */
  const delivered = async (count: number) => {
    for (let i = 0; i < 100 && sent.length < count; i++) await new Promise((r) => setTimeout(r, 20));
    assert.equal(sent.length, count, JSON.stringify(sent.map((s) => s.payload)));
  };

  before(async () => {
    ({ app, baseUrl } = await startTestApp({
      pushSender: async (subscription, payload, ttl) => {
        if (gone.has(subscription.endpoint)) throw Object.assign(new Error("Gone"), { statusCode: 410 });
        const refusal = refusing.get(subscription.endpoint);
        if (refusal) throw Object.assign(new Error("Refused"), { statusCode: refusal });
        sent.push({ subscription, payload: JSON.parse(payload), ttl });
      },
    }));
  });
  after(async () => {
    await app.close();
  });
  beforeEach(async () => {
    await Promise.all(sockets.splice(0).map((s) => s.close()));
    await resetDb(app);
    sent.length = 0;
    gone.clear();
    refusing.clear();
  });

  test("subscribing needs a session and a real push service", async () => {
    const a = await createUser(app, "alice");
    // The key itself is public; subscribing is not
    assert.equal((await app.inject({ method: "GET", url: "/api/push/key" })).json().publicKey, "test-public-key");
    assert.equal(
      (await app.inject({ method: "POST", url: "/api/push/subscriptions", payload: { endpoint: endpointFor("x"), keys } }))
        .statusCode,
      401
    );

    assert.equal((await subscribe(a.clerkId, "one")).statusCode, 201);
    // Again: no duplicate
    assert.equal((await subscribe(a.clerkId, "one")).statusCode, 201);
    const count = async () => (await app.pg.query(`SELECT 1 FROM push_subscriptions`)).rowCount;
    assert.equal(await count(), 1);

    const refused = async (payload: object, code: string) => {
      const response = await call("POST", "/api/push/subscriptions", a.clerkId, payload);
      assert.equal(response.statusCode, 400, JSON.stringify(payload));
      assert.equal(response.json().code, code);
    };
    // The server would otherwise send requests wherever a client points it
    await refused({ endpoint: "https://169.254.169.254/latest", keys }, "PUSH_ENDPOINT_NOT_ALLOWED");
    await refused({ endpoint: "http://localhost:6379/", keys }, "PUSH_ENDPOINT_NOT_ALLOWED");
    await refused({ endpoint: endpointFor("x"), keys: { ...keys, p256dh: "short" } }, "VALIDATION_ERROR");
    await refused({ endpoint: endpointFor("x"), keys: { ...keys, auth: "not base64!!not base64" } }, "VALIDATION_ERROR");
    await refused({ endpoint: endpointFor("x") }, "VALIDATION_ERROR");
    assert.equal(await count(), 1);
  });

  test("a challenge reaches every browser of the challenged player, and only theirs", async () => {
    const a = await createUser(app, "alice");
    const b = await createUser(app, "bobby");
    await subscribe(a.clerkId, "alice-laptop");
    await subscribe(b.clerkId, "bobby-laptop");
    await subscribe(b.clerkId, "bobby-phone");
    const na = await open("/notifications", a.clerkId);
    const nb = await open("/notifications", b.clerkId);

    na.send({ type: "challenge_sent", data: { challengedId: b.id, color: "white", time: 300, increment: 3 } });
    await nb.next("challenge_received");
    await delivered(2);
    assert.deepEqual(sent.map((s) => s.subscription.endpoint).sort(), [
      endpointFor("bobby-laptop"),
      endpointFor("bobby-phone"),
    ]);
    assert.deepEqual(sent[0]!.payload, {
      title: "alice challenged you",
      body: "5+3. You play Black.",
      url: "/home",
      tag: `challenge-${a.id}`,
    });
    // Not worth delivering once the challenge has expired
    assert.equal(sent[0]!.ttl, 600);

    // Accepting tells the challenger their game has started
    sent.length = 0;
    nb.send({ type: "challenge_accepted", data: { challengerId: a.id } });
    const created = await na.next("match_created");
    await delivered(1);
    assert.equal(sent[0]!.subscription.endpoint, endpointFor("alice-laptop"));
    assert.equal(sent[0]!.payload.title, "bobby accepted your challenge");
    assert.equal(sent[0]!.payload.url, `/game/${created.data.gameId}`);
  });

  test("friend requests and their acceptance are announced", async () => {
    const a = await createUser(app, "alice");
    const b = await createUser(app, "bobby");
    await subscribe(a.clerkId, "alice");
    await subscribe(b.clerkId, "bobby");

    const request = await call("POST", "/api/friend-requests", a.clerkId, { receiverId: b.id });
    assert.equal(request.statusCode, 201);
    await delivered(1);
    assert.equal(sent[0]!.subscription.endpoint, endpointFor("bobby"));
    assert.equal(sent[0]!.payload.body, "alice wants to be friends.");
    assert.equal(sent[0]!.payload.url, `/profile/${b.id}/friends`);

    sent.length = 0;
    const accepted = await call("POST", `/api/friend-requests/${request.json().data.id}/accept`, b.clerkId);
    assert.equal(accepted.statusCode, 200);
    await delivered(1);
    assert.equal(sent[0]!.subscription.endpoint, endpointFor("alice"));
    assert.equal(sent[0]!.payload.title, "Friend request accepted");
  });

  test("a subscription the push service has dropped is forgotten", async () => {
    const a = await createUser(app, "alice");
    await subscribe(a.clerkId, "old-phone");
    await subscribe(a.clerkId, "laptop");
    gone.add(endpointFor("old-phone"));

    await app.push.notify(a.id, { title: "t", body: "b", url: "/home", tag: "x" });
    assert.equal(sent.length, 1);
    const { rows } = await app.pg.query<{ endpoint: string }>(`SELECT endpoint FROM push_subscriptions`);
    assert.deepEqual(rows.map((r) => r.endpoint), [endpointFor("laptop")]);
  });

  test("FCM subscriptions made for other keys are forgotten; other refusals after a few in a row", async () => {
    const a = await createUser(app, "alice");
    await subscribe(a.clerkId, "old-keys");
    await subscribe(a.clerkId, "flaky");
    await subscribe(a.clerkId, "busy");
    refusing.set(endpointFor("old-keys"), 403);
    refusing.set(endpointFor("flaky"), 400);
    // A server error is the push service's problem, never the subscription's
    refusing.set(endpointFor("busy"), 503);
    const endpoints = async () =>
      (await app.pg.query<{ endpoint: string }>(`SELECT endpoint FROM push_subscriptions ORDER BY id`)).rows.map(
        (r) => r.endpoint
      );

    await app.push.notify(a.id, { title: "t", body: "b", url: "/home", tag: "n1" });
    assert.deepEqual(await endpoints(), [endpointFor("flaky"), endpointFor("busy")]);
    // A success in between starts the count again
    refusing.delete(endpointFor("flaky"));
    await app.push.notify(a.id, { title: "t", body: "b", url: "/home", tag: "n2" });
    refusing.set(endpointFor("flaky"), 400);
    await app.push.notify(a.id, { title: "t", body: "b", url: "/home", tag: "n3" });
    await app.push.notify(a.id, { title: "t", body: "b", url: "/home", tag: "n4" });
    assert.deepEqual(await endpoints(), [endpointFor("flaky"), endpointFor("busy")]);
    await app.push.notify(a.id, { title: "t", body: "b", url: "/home", tag: "n5" });
    assert.deepEqual(await endpoints(), [endpointFor("busy")]);
    for (let i = 0; i < 5; i++) await app.push.notify(a.id, { title: "t", body: "b", url: "/home", tag: `m${i}` });
    assert.deepEqual(await endpoints(), [endpointFor("busy")]);
  });

  test("a 403 from a push service other than FCM only counts as a failure", async () => {
    // Apple's service answers 403 when it rejects our VAPID token itself (a
    // subject it doesn't accept, clock skew): not a reason to drop at once
    const a = await createUser(app, "alice");
    const safari = "https://web.push.apple.com/QGuQyavXutnMH-Some-Token";
    assert.equal((await call("POST", "/api/push/subscriptions", a.clerkId, { endpoint: safari, keys })).statusCode, 201);
    refusing.set(safari, 403);
    const stored = async () =>
      (await app.pg.query<{ failures: number }>(`SELECT failures FROM push_subscriptions WHERE endpoint = $1`, [safari]))
        .rows[0]?.failures;

    await app.push.notify(a.id, { title: "t", body: "b", url: "/home", tag: "s1" });
    await app.push.notify(a.id, { title: "t", body: "b", url: "/home", tag: "s2" });
    assert.equal(await stored(), 2);
    await app.push.notify(a.id, { title: "t", body: "b", url: "/home", tag: "s3" });
    assert.equal(await stored(), undefined);
  });

  test("one notification per kind and sender within the window, and only so many a minute", async () => {
    const a = await createUser(app, "alice");
    await subscribe(a.clerkId, "phone");
    const notify = (tag: string) => app.push.notify(a.id, { title: tag, body: "", url: "/home", tag });

    await notify("challenge-7");
    await notify("challenge-7");
    assert.deepEqual(sent.map((s) => s.payload.tag), ["challenge-7"]);
    // Another sender, or another kind, isn't a duplicate
    await notify("challenge-8");
    await notify("friend-request-7");
    assert.equal(sent.length, 3);
    // Once the window is over the same one goes again
    await app.redis.del(`push:sent:${a.id}:challenge-7`);
    await notify("challenge-7");
    assert.equal(sent.length, 4);

    // Every kind counts against the per-minute limit
    for (let i = 0; i < PUSH_LIMITS.RECIPIENT_LIMIT.max; i++) await notify(`game-${i}`);
    assert.equal(sent.length, PUSH_LIMITS.RECIPIENT_LIMIT.max);
    // Someone else's devices aren't affected
    const b = await createUser(app, "bobby");
    await subscribe(b.clerkId, "bobby-phone");
    await app.push.notify(b.id, { title: "t", body: "", url: "/home", tag: "game-1" });
    assert.equal(sent.length, PUSH_LIMITS.RECIPIENT_LIMIT.max + 1);

    // One turned away by the limit doesn't use up its tag: once the minute
    // is over it still goes out (a friend request's window is a whole day)
    await app.push.notify(a.id, { title: "t", body: "", url: "/home", tag: "friend-request-9" }, 60, {
      dedupeSeconds: 24 * 60 * 60,
    });
    assert.equal(sent.length, PUSH_LIMITS.RECIPIENT_LIMIT.max + 1);
    assert.equal(await app.redis.exists(`push:sent:${a.id}:friend-request-9`), 0);
    await app.redis.del(`push:rate:${a.id}`);
    await app.push.notify(a.id, { title: "t", body: "", url: "/home", tag: "friend-request-9" }, 60, {
      dedupeSeconds: 24 * 60 * 60,
    });
    assert.equal(sent.at(-1)!.payload.tag, "friend-request-9");
    assert.equal(sent.length, PUSH_LIMITS.RECIPIENT_LIMIT.max + 2);
  });

  test("re-sending a challenge or a friend request doesn't notify again", async () => {
    const a = await createUser(app, "alice");
    const b = await createUser(app, "bobby");
    await subscribe(b.clerkId, "bobby");
    await app.pg.query(`INSERT INTO friends ("userOneId", "userTwoId") VALUES ($1, $2)`, [a.id, b.id]);
    const na = await open("/notifications", a.clerkId);
    const nb = await open("/notifications", b.clerkId);
    const challenge = (time: number) =>
      na.send({ type: "challenge_sent", data: { challengedId: b.id, color: "white", time, increment: 0 } });
    challenge(300);
    await nb.next("challenge_received");
    challenge(180);
    await nb.next("challenge_received");
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(sent.length, 1);

    // A friend request after cancelling one isn't announced twice either
    // (the cooldown after a cancel is lifted here to get that far)
    const c = await createUser(app, "carol");
    sent.length = 0;
    const first = await call("POST", "/api/friend-requests", c.clerkId, { receiverId: b.id });
    await delivered(1);
    await call("DELETE", `/api/friend-requests/${first.json().data.id}`, c.clerkId);
    await app.redis.del(`friendreq:cooldown:${c.id}:${b.id}`);
    assert.equal((await call("POST", "/api/friend-requests", c.clerkId, { receiverId: b.id })).statusCode, 201);
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(sent.length, 1);
  });

  test("a browser belongs to whoever signed in on it last, and can be turned off", async () => {
    const a = await createUser(app, "alice");
    const b = await createUser(app, "bobby");
    await subscribe(a.clerkId, "shared-computer");
    await subscribe(b.clerkId, "shared-computer");

    await app.push.notify(a.id, { title: "for alice", body: "", url: "/home", tag: "x1" });
    assert.equal(sent.length, 0);
    await app.push.notify(b.id, { title: "for bobby", body: "", url: "/home", tag: "x1" });
    assert.equal(sent.length, 1);

    // Only your own subscription can be removed
    sent.length = 0;
    await call("POST", "/api/push/unsubscribe", a.clerkId, { endpoint: endpointFor("shared-computer") });
    await app.push.notify(b.id, { title: "still bobby's", body: "", url: "/home", tag: "x2" });
    assert.equal(sent.length, 1);
    await call("POST", "/api/push/unsubscribe", b.clerkId, { endpoint: endpointFor("shared-computer") });
    await app.push.notify(b.id, { title: "off", body: "", url: "/home", tag: "x3" });
    assert.equal(sent.length, 1);
  });

  test("only the ten most recent browsers are kept", async () => {
    const a = await createUser(app, "alice");
    for (let i = 0; i < 12; i++) await subscribe(a.clerkId, `device-${i}`);
    const { rows } = await app.pg.query<{ endpoint: string }>(`SELECT endpoint FROM push_subscriptions ORDER BY id`);
    assert.equal(rows.length, 10);
    assert.equal(rows[0]!.endpoint, endpointFor("device-2"));
  });
});
