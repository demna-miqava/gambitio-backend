import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import type { FastifyInstance } from "fastify";
import { createUser, integrationEnabled, resetDb, startTestApp } from "./helpers.js";

const skip = !integrationEnabled && "TEST_POSTGRES_URL / TEST_REDIS_URL not set";

describe("game history filters", { skip }, () => {
  let app: FastifyInstance;
  let alice: { id: number; clerkId: string };
  let bob: { id: number; clerkId: string };
  let carol: { id: number; clerkId: string };
  /** Game ids by name, for readable assertions */
  const ids: Record<string, number> = {};

  const games = async (query: string, as = bob.clerkId, of = alice.id) => {
    const res = await app.inject({
      url: `/api/users/${of}/games?limit=50${query ? `&${query}` : ""}`,
      headers: { authorization: `Bearer ${as}` },
    });
    assert.equal(res.statusCode, 200, res.body);
    return res.json();
  };
  const names = (body: { data: { id: number }[] }) =>
    body.data.map((g) => Object.keys(ids).find((k) => ids[k] === g.id)).sort();

  /** A game of Alice's; minutesAgo orders them (newest first) */
  const game = async (
    name: string,
    g: {
      white: number | null;
      black: number | null;
      result: "white_win" | "black_win" | "draw" | "aborted" | null;
      time?: number;
      rated?: boolean;
      botId?: string;
      tableGame?: boolean;
      tournamentId?: number;
      daysAgo?: number;
      names?: [string, string];
    }
  ) => {
    const winner = g.result === "white_win" ? g.white : g.result === "black_win" ? g.black : null;
    const { rows } = await app.pg.query<{ id: number }>(
      `INSERT INTO games ("whiteId", "blackId", "whiteUsername", "blackUsername", "whiteRating", "blackRating",
         time, increment, status, result, "winnerId", rated, "botId", "tableGame", "tournamentId", "createdAt")
       VALUES ($1, $2, $3, $4, 1200, 1200, $5, 0, $6, $7, $8, $9, $10, $11, $12, now() - make_interval(days => $13))
       RETURNING id`,
      [
        g.white,
        g.black,
        g.names?.[0] ?? "w",
        g.names?.[1] ?? "b",
        g.time ?? 300,
        g.result === null ? "in_progress" : "finished",
        g.result,
        winner,
        g.rated ?? !(g.botId || g.tableGame),
        g.botId ?? null,
        g.tableGame ?? false,
        g.tournamentId ?? null,
        g.daysAgo ?? 0,
      ]
    );
    ids[name] = rows[0]!.id;
  };

  before(async () => {
    ({ app } = await startTestApp());
  });
  after(async () => {
    await app.close();
  });
  beforeEach(async () => {
    await resetDb(app);
    for (const key of Object.keys(ids)) delete ids[key];
    alice = await createUser(app, "alice");
    bob = await createUser(app, "bob");
    carol = await createUser(app, "carol");
    const { rows } = await app.pg.query<{ id: number }>(
      `INSERT INTO tournaments ("createdBy", name, time, "startsAt", "endsAt", status)
       VALUES ($1, 'Arena', 180, now() - interval '2 hours', now() - interval '1 hour', 'finished') RETURNING id`,
      [carol.id]
    );
    const tournamentId = rows[0]!.id;

    // Blitz, rated, against Bob, the name he had then
    await game("winWhiteBob", { white: alice.id, black: bob.id, result: "white_win", daysAgo: 1, names: ["alice", "oldbob"] });
    await game("lossBlackBob", { white: bob.id, black: alice.id, result: "white_win", daysAgo: 2 });
    await game("drawWhiteCarolBullet", { white: alice.id, black: carol.id, result: "draw", time: 60, daysAgo: 3 });
    await game("winBlackCarolRapidUnrated", {
      white: carol.id,
      black: alice.id,
      result: "black_win",
      time: 900,
      rated: false,
      daysAgo: 10,
    });
    await game("lossWhiteBot", { white: alice.id, black: null, result: "black_win", botId: "bot-1200", daysAgo: 20 });
    await game("winBlackTable", { white: null, black: alice.id, result: "black_win", tableGame: true, daysAgo: 30 });
    await game("winWhiteArena", { white: alice.id, black: carol.id, result: "white_win", time: 180, tournamentId, daysAgo: 40 });
    await game("liveBob", { white: alice.id, black: bob.id, result: null });
    // Never listed
    await game("abortedBob", { white: alice.id, black: bob.id, result: "aborted", daysAgo: 4 });
    await app.pg.query(`UPDATE users SET "listedGames" = 7 WHERE id = $1`, [alice.id]);
  });

  test("without filters the history is as before", async () => {
    const all = await games("");
    assert.equal(all.data.length, 8);
    assert.equal(all.data[0].id, ids.liveBob);
    assert.deepEqual(all.pagination, { page: 1, limit: 50, total: 8, totalPages: 1 });
    assert.equal(all.opponent, undefined);
  });

  test("result, colour, time control, rated, kind and dates, each from the owner's side", async () => {
    assert.deepEqual(names(await games("result=won")), [
      "winBlackCarolRapidUnrated",
      "winBlackTable",
      "winWhiteArena",
      "winWhiteBob",
    ]);
    assert.deepEqual(names(await games("result=lost")), ["lossBlackBob", "lossWhiteBot"]);
    assert.deepEqual(names(await games("result=drawn")), ["drawWhiteCarolBullet"]);
    assert.deepEqual(names(await games("color=black")), [
      "lossBlackBob",
      "winBlackCarolRapidUnrated",
      "winBlackTable",
    ]);
    assert.deepEqual(names(await games("timeControl=bullet")), ["drawWhiteCarolBullet"]);
    assert.deepEqual(names(await games("timeControl=rapid")), ["winBlackCarolRapidUnrated"]);
    // 180 s is blitz (getTimeControl)
    assert.ok(names(await games("timeControl=blitz")).includes("winWhiteArena"));
    assert.deepEqual(names(await games("rated=false")), [
      "lossWhiteBot",
      "winBlackCarolRapidUnrated",
      "winBlackTable",
    ]);
    assert.deepEqual(names(await games("kind=bot")), ["lossWhiteBot"]);
    assert.deepEqual(names(await games("kind=table")), ["winBlackTable"]);
    assert.deepEqual(names(await games("kind=tournament")), ["winWhiteArena"]);
    assert.deepEqual(names(await games("kind=online")), [
      "drawWhiteCarolBullet",
      "liveBob",
      "lossBlackBob",
      "winBlackCarolRapidUnrated",
      "winWhiteBob",
    ]);
    const since = new Date(Date.now() - 5 * 86_400_000).toISOString();
    const before = new Date(Date.now() - 1.5 * 86_400_000).toISOString();
    assert.deepEqual(names(await games(`since=${since}&before=${before}`)), ["drawWhiteCarolBullet", "lossBlackBob"]);
  });

  test("filters combine, count every match and page", async () => {
    assert.deepEqual(names(await games("result=won&color=white&kind=online")), ["winWhiteBob"]);
    assert.deepEqual(names(await games("result=won&color=black&rated=true")), []);
    const page = await games("result=won").then(() =>
      app.inject({
        url: `/api/users/${alice.id}/games?result=won&limit=3&page=2`,
        headers: { authorization: `Bearer ${bob.clerkId}` },
      })
    );
    const body = page.json();
    assert.deepEqual(body.pagination, { page: 2, limit: 3, total: 4, totalPages: 2 });
    // Newest first: Bob (1 day), Carol (10), table (30), then the arena game (40)
    assert.deepEqual(names(body), ["winWhiteArena"]);
  });

  test("the opponent is found by their current name, any case", async () => {
    const vsBob = await games("opponent=BOB");
    assert.deepEqual(names(vsBob), ["liveBob", "lossBlackBob", "winWhiteBob"]);
    assert.deepEqual(vsBob.opponent, { id: bob.id, username: "bob" });
    assert.deepEqual(names(await games("opponent=bob&result=won")), ["winWhiteBob"]);
    // The name stored on the game doesn't count
    assert.deepEqual(names(await games("opponent=oldbob")), []);
    const nobody = await games("opponent=nobody_here");
    assert.equal(nobody.opponent, null);
    assert.deepEqual(nobody.pagination.total, 0);
  });

  test("blocks change nothing, as before", async () => {
    await app.pg.query(`INSERT INTO user_blocks ("blockerId", "blockedId") VALUES ($1, $2)`, [alice.id, bob.id]);
    // Bob still sees Alice's history, his games with her included, and she hers with him
    assert.deepEqual(names(await games("opponent=bob", bob.clerkId)), ["liveBob", "lossBlackBob", "winWhiteBob"]);
    assert.equal((await games("result=lost", alice.clerkId)).data.length, 2);
  });

  test("bad filter values are refused", async () => {
    for (const query of [
      "result=win",
      "timeControl=classical",
      "color=red",
      "rated=yes",
      "kind=live",
      "opponent=a%20b",
      "opponent=x'%20OR%201=1--",
      "since=not-a-date",
      `since=${new Date().toISOString()}&before=2020-01-01T00:00:00Z`,
    ]) {
      const res = await app.inject({
        url: `/api/users/${alice.id}/games?${query}`,
        headers: { authorization: `Bearer ${bob.clerkId}` },
      });
      assert.equal(res.statusCode, 400, query);
    }
  });
});
