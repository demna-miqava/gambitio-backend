import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import type { FastifyInstance } from "fastify";
import { connect, createUser, integrationEnabled, resetDb, startTestApp, type TestSocket } from "./helpers.js";
import { createGame } from "../src/services/gameService.js";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("matchmaking races", { skip: !integrationEnabled && "TEST_POSTGRES_URL / TEST_REDIS_URL not set" }, () => {
  let app: FastifyInstance;
  let baseUrl: string;
  const sockets: TestSocket[] = [];
  const open = async (path: string, clerkId: string) => {
    const socket = await connect(baseUrl, path, clerkId);
    sockets.push(socket);
    return socket;
  };
  const search = (clerkId: string) => open("/matchmaking?time=60&increment=0", clerkId);
  const queued = async () =>
    (await app.pg.query<{ userId: number }>(`SELECT "userId" FROM matchmaking ORDER BY id`)).rows.map(
      (r) => r.userId
    );
  const games = async () => (await app.pg.query(`SELECT id FROM games`)).rowCount;

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

  test("an opponent whose account is gone is dropped; the searching player keeps searching", async () => {
    const gone = await createUser(app, "gone");
    const sg = await search(gone.clerkId);
    await sg.next("searching");
    // Deleted with its search still in the queue (a search that raced the deletion)
    await app.pg.query(`UPDATE users SET "clerkId" = NULL WHERE id = $1`, [gone.id]);

    const a = await createUser(app, "alice");
    const sa = await search(a.clerkId);
    await sa.next("searching");
    await sa.none("error");
    assert.deepEqual(await queued(), [a.id]);

    const b = await createUser(app, "bobby");
    const sb = await search(b.clerkId);
    await Promise.all([sa.next("match_found"), sb.next("match_found")]);
  });

  test("an opponent who goes into a game while being paired is dropped, not the searching player", async () => {
    const b = await createUser(app, "bobby");
    const d = await createUser(app, "dave");
    const sb = await search(b.clerkId);
    await sb.next("searching");

    const a = await createUser(app, "alice");
    let sa: TestSocket | undefined;
    // Bobby's game with Dave is being created (his row locked, the game not
    // yet visible) while Alice's search picks him
    await app.pg.transact(async (tx) => {
      await createGame(tx, { whiteId: b.id, blackId: d.id, time: 60, increment: 0 });
      sa = await search(a.clerkId);
      await sa.next("searching");
      await sleep(200);
    });
    await sa!.none("error");
    await sa!.none("match_found");
    assert.deepEqual(await queued(), [a.id]);
    assert.equal(await games(), 1);
  });

  test("the sweep goes on past an entry whose own player can't be paired", async () => {
    const a = await createUser(app, "alice", 1200);
    const b = await createUser(app, "bobby", 1900);
    const c = await createUser(app, "carol", 2600);
    const sa = await search(a.clerkId);
    await sa.next("searching");
    const sb = await search(b.clerkId);
    await sb.next("searching");
    const sc = await search(c.clerkId);
    await sc.next("searching");
    // Alice's account goes while her search is queued; Bobby and Carol come
    // within reach of her and of each other
    await app.pg.query(`UPDATE users SET "clerkId" = NULL WHERE id = $1`, [a.id]);
    await app.pg.query(`UPDATE matchmaking SET rating = 1210 WHERE "userId" = ANY($1)`, [[b.id, c.id]]);

    await app.matchmaking.sweep();
    await Promise.all([sb.next("match_found"), sc.next("match_found")]);
    assert.deepEqual(await queued(), []);
  });

  test("cancelling while the search is still being added never pairs the player", async () => {
    const b = await createUser(app, "bobby");
    const sb = await search(b.clerkId);
    await sb.next("searching");

    const enqueue = app.matchmaking.enqueue;
    app.matchmaking.enqueue = async (...args) => {
      await sleep(200);
      return enqueue.apply(app.matchmaking, args);
    };
    try {
      const a = await createUser(app, "alice");
      const sa = await search(a.clerkId);
      // The client doesn't read the server's close frame yet, so the
      // server's "close" event can't come before the search is added
      sa.ws.pause();
      sa.send({ type: "cancel_match" });
      await sleep(400);
      assert.equal(await games(), 0);
      assert.deepEqual(await queued(), [b.id]);
      await sb.none("match_found");
      sa.ws.resume();
    } finally {
      app.matchmaking.enqueue = enqueue;
    }
  });

  test("two tabs searching at once both search, with one queue entry", async () => {
    const a = await createUser(app, "alice");
    const [s1, s2] = await Promise.all([search(a.clerkId), search(a.clerkId)]);
    await Promise.all([s1.next("searching"), s2.next("searching")]);
    await s1.none("error", 100);
    await s2.none("error", 100);
    assert.deepEqual(await queued(), [a.id]);
  });

  test("a pairing withdraws the players' other challenges, and tells the other side", async () => {
    const a = await createUser(app, "alice");
    const b = await createUser(app, "bobby");
    const c = await createUser(app, "carol");
    const na = await open("/notifications", a.clerkId);
    const nc = await open("/notifications", c.clerkId);
    await sleep(100);
    na.send({ type: "challenge_sent", data: { challengedId: c.id, color: "white", time: 300, increment: 0 } });
    await nc.next("challenge_received");

    const sa = await search(a.clerkId);
    await sa.next("searching");
    const sb = await search(b.clerkId);
    await Promise.all([sa.next("match_found"), sb.next("match_found")]);
    assert.equal((await nc.next("challenge_cancelled")).data.challengerId, a.id);
    const withdrawn = (await na.next("challenge_declined")).data;
    assert.equal(withdrawn.challengedId, c.id);
    assert.equal(withdrawn.reason, "playing");
    assert.equal((await app.pg.query(`SELECT 1 FROM challenges`)).rowCount, 0);
  });
});
