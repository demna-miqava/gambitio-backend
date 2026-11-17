import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import type { FastifyInstance } from "fastify";
import { connect, createUser, integrationEnabled, resetDb, startTestApp, type TestSocket } from "./helpers.js";
import { isPushServiceEndpoint, timeControlLabel, type StoredSubscription } from "../src/services/pushService.js";
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

  const open = async (path: string, clerkId: string) => {
    const socket = await connect(baseUrl, path, clerkId);
    sockets.push(socket);
    return socket;
  };
  const call = (method: "GET" | "POST", url: string, clerkId: string, payload?: object) =>
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

  test("a browser belongs to whoever signed in on it last, and can be turned off", async () => {
    const a = await createUser(app, "alice");
    const b = await createUser(app, "bobby");
    await subscribe(a.clerkId, "shared-computer");
    await subscribe(b.clerkId, "shared-computer");

    await app.push.notify(a.id, { title: "for alice", body: "", url: "/home", tag: "x" });
    assert.equal(sent.length, 0);
    await app.push.notify(b.id, { title: "for bobby", body: "", url: "/home", tag: "x" });
    assert.equal(sent.length, 1);

    // Only your own subscription can be removed
    sent.length = 0;
    await call("POST", "/api/push/unsubscribe", a.clerkId, { endpoint: endpointFor("shared-computer") });
    await app.push.notify(b.id, { title: "still bobby's", body: "", url: "/home", tag: "x" });
    assert.equal(sent.length, 1);
    await call("POST", "/api/push/unsubscribe", b.clerkId, { endpoint: endpointFor("shared-computer") });
    await app.push.notify(b.id, { title: "off", body: "", url: "/home", tag: "x" });
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
