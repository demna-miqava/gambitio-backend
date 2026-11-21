import { after, afterEach, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import type { FastifyInstance } from "fastify";
import WebSocket from "ws";
import { connect, createUser, integrationEnabled, resetDb, startTestApp, type TestSocket } from "./helpers.js";
import { createGame } from "../src/services/gameService.js";
import {
  START_GRACE_MS,
  TOURNAMENTS_PER_DAY,
  TournamentService,
  tournamentPresenceKey,
  tournamentTimings,
  type CreateTournamentInput,
} from "../src/services/tournamentService.js";
import { tournamentRepository } from "../src/repositories/tournamentRepository.js";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type User = { id: number; clerkId: string };

describe("arena tournaments", { skip: !integrationEnabled && "TEST_POSTGRES_URL / TEST_REDIS_URL not set" }, () => {
  let app: FastifyInstance;
  let baseUrl: string;
  let a: User;
  let b: User;
  let c: User;
  let d: User;
  const sockets: TestSocket[] = [];

  const open = async (path: string, user: User) => {
    const socket = await connect(baseUrl, path, user.clerkId);
    sockets.push(socket);
    return socket;
  };
  /** Opens the tournament's lobby for a user, which is what makes them count as here. */
  const lobby = async (user: User, tournamentId: number) => {
    const socket = await open(`/tournament/${tournamentId}`, user);
    await socket.next("state");
    return socket;
  };

  const request = async (user: User | null, method: "GET" | "POST" | "DELETE", path: string, body?: object) => {
    const res = await fetch(`http://${baseUrl}/api${path}`, {
      method,
      headers: {
        ...(user ? { authorization: `Bearer ${user.clerkId}` } : {}),
        ...(body ? { "content-type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    return { status: res.status, body: text ? (JSON.parse(text) as any) : null };
  };

  const input = (over: Partial<CreateTournamentInput> = {}): CreateTournamentInput => ({
    name: "Friday Blitz",
    time: 180,
    increment: 0,
    minutes: 30,
    startsAt: new Date(),
    rated: true,
    maxPlayers: 100,
    ...over,
  });

  /** A tournament by `a` that the others have joined, started, with everyone's lobby open. */
  const running = async (players: User[] = [a, b, c, d], over: Partial<CreateTournamentInput> = {}) => {
    const { tournament } = await app.tournaments.create(a.id, input(over));
    for (const player of players.filter((p) => p.id !== a.id)) await app.tournaments.join(tournament.id, player.id);
    const lobbies = new Map<number, TestSocket>();
    for (const player of players) lobbies.set(player.id, await lobby(player, tournament.id));
    assert.equal(await app.tournaments.start(tournament.id), "running");
    return { id: tournament.id, lobbies };
  };

  const row = async (tournamentId: number, user: User) =>
    (
      await app.pg.query(
        `SELECT status, score, streak, games, wins, draws, sheet, whites, "lastOpponentId",
                "waitingSince" IS NOT NULL AS waiting
         FROM tournament_players WHERE "tournamentId" = $1 AND "userId" = $2`,
        [tournamentId, user.id]
      )
    ).rows[0];
  const game = async (gameId: number) =>
    (
      await app.pg.query(
        `SELECT "whiteId", "blackId", "tournamentId", rated, status, result, "endReason", "numMoves",
                "whiteRatingChange", "blackRatingChange"
         FROM games WHERE id = $1`,
        [gameId]
      )
    ).rows[0];
  const blitz = async (user: User) =>
    (await app.pg.query(`SELECT "blitzRating" FROM users WHERE id = $1`, [user.id])).rows[0].blitzRating;
  const byId = (id: number) => [a, b, c, d].find((u) => u.id === id)!;

  /** Plays one move each, then white resigns: black wins a game that counts. */
  const blackWins = async (gameId: number) => {
    const g = await game(gameId);
    await app.liveGames.move(gameId, g.whiteId, { from: "e2", to: "e4" });
    await app.liveGames.move(gameId, g.blackId, { from: "e7", to: "e5" });
    await app.liveGames.resign(gameId, g.whiteId);
    return { winner: byId(g.blackId), loser: byId(g.whiteId) };
  };

  const requeueDelayMs = tournamentTimings.requeueDelayMs;
  before(async () => {
    ({ app, baseUrl } = await startTestApp());
    // Paired again at once after a game, so rounds don't wait (one test turns it back on)
    tournamentTimings.requeueDelayMs = 0;
  });
  after(async () => {
    tournamentTimings.requeueDelayMs = requeueDelayMs;
    await app.close();
  });
  beforeEach(async () => {
    await resetDb(app);
    a = await createUser(app, "anna", 1500);
    b = await createUser(app, "boris", 1450);
    c = await createUser(app, "clara", 1400);
    d = await createUser(app, "dmitri", 1350);
  });
  afterEach(async () => {
    await Promise.all(sockets.splice(0).map((s) => s.close()));
  });

  test("creating one makes its creator the first player, and allows one open tournament each", async () => {
    assert.equal((await request(null, "GET", "/tournaments")).status, 401);
    const startsAt = new Date(Date.now() + 10 * 60_000).toISOString();
    const created = await request(a, "POST", "/tournaments", {
      name: "  Friday​   Blitz ",
      time: 180,
      increment: 2,
      minutes: 45,
      startsAt,
    });
    assert.equal(created.status, 201);
    const { tournament, me, standings } = created.body;
    assert.equal(tournament.name, "Friday Blitz");
    assert.deepEqual(
      [tournament.status, tournament.type, tournament.rated, tournament.playerCount, tournament.maxPlayers],
      ["scheduled", "blitz", true, 1, 100]
    );
    assert.equal(tournament.createdBy.username, "anna");
    assert.equal(new Date(tournament.endsAt).getTime() - new Date(tournament.startsAt).getTime(), 45 * 60_000);
    assert.deepEqual([me.userId, me.rank, me.score, me.status], [a.id, 1, 0, "active"]);
    assert.equal(standings.length, 1);

    const again = await request(a, "POST", "/tournaments", { name: "Another", time: 60, minutes: 10, startsAt });
    assert.deepEqual([again.status, again.body.code], [409, "TOURNAMENT_LIMIT"]);

    for (const bad of [
      { name: "ab", time: 180, minutes: 30, startsAt },
      { name: "Fine name", time: 5, minutes: 30, startsAt },
      { name: "Fine name", time: 180, minutes: 5, startsAt },
      { name: "Fine name", time: 180, minutes: 30, startsAt, maxPlayers: 1 },
      { name: "Fine name", time: 180, minutes: 30, startsAt: new Date(Date.now() + 30 * 24 * 3600_000).toISOString() },
      { name: "Fine name", time: 180, minutes: 30, startsAt, prize: "a car" },
      // A start that isn't a time written out: none of these is "now"
      { name: "Fine name", time: 180, minutes: 30, startsAt: null },
      { name: "Fine name", time: 180, minutes: 30, startsAt: true },
      { name: "Fine name", time: 180, minutes: 30, startsAt: 5 },
      { name: "Fine name", time: 180, minutes: 30, startsAt: "soon" },
    ]) {
      assert.equal((await request(b, "POST", "/tournaments", bad)).status, 400, JSON.stringify(bad));
    }

    // The list: open ones, with whether the caller is in
    const mine = await request(a, "GET", "/tournaments");
    assert.deepEqual(
      mine.body.data.map((t: any) => [t.name, t.joined]),
      [["Friday Blitz", true]]
    );
    assert.equal((await request(b, "GET", "/tournaments")).body.data[0].joined, false);
    assert.deepEqual((await request(a, "GET", "/tournaments?status=finished")).body.data, []);
    assert.equal((await request(a, "GET", "/tournaments/999")).status, 404);
  });

  test("joining, pausing and leaving before the start", async () => {
    const { tournament } = await app.tournaments.create(a.id, input({ startsAt: new Date(Date.now() + 600_000), maxPlayers: 3 }));
    const path = `/tournaments/${tournament.id}`;
    const count = async () => (await request(a, "GET", path)).body.tournament.playerCount;

    const joined = await request(b, "POST", `${path}/join`);
    assert.deepEqual([joined.status, joined.body.me.status], [200, "active"]);
    // Joining twice changes nothing
    await request(b, "POST", `${path}/join`);
    assert.equal(await count(), 2);

    assert.equal((await request(b, "POST", `${path}/pause`)).body.me.status, "paused");
    assert.equal(await count(), 2);
    assert.equal((await request(b, "POST", `${path}/join`)).body.me.status, "active");
    assert.deepEqual((await request(c, "POST", `${path}/pause`)).body.code, "NOT_IN_TOURNAMENT");

    await request(c, "POST", `${path}/join`);
    assert.deepEqual(await request(d, "POST", `${path}/join`).then((r) => [r.status, r.body.code]), [409, "TOURNAMENT_FULL"]);

    // Leaving before playing: gone, and the place is free again
    assert.equal((await request(c, "POST", `${path}/withdraw`)).status, 204);
    assert.equal(await row(tournament.id, c), undefined);
    assert.equal(await count(), 2);
    assert.equal((await request(c, "POST", `${path}/withdraw`)).body.code, "NOT_IN_TOURNAMENT");
    assert.equal((await request(d, "POST", `${path}/join`)).status, 200);
    assert.equal((await request(d, "GET", path)).body.me.userId, d.id);
    assert.equal((await request(c, "GET", path)).body.me, null);

    // Only the creator calls it off, and only before it starts
    assert.equal((await request(b, "DELETE", path)).status, 403);
    assert.equal((await request(a, "DELETE", path)).status, 204);
    assert.equal((await request(a, "GET", path)).body.tournament.status, "cancelled");
    assert.deepEqual(await request(c, "POST", `${path}/join`).then((r) => [r.status, r.body.code]), [409, "TOURNAMENT_CLOSED"]);
    assert.equal((await request(a, "DELETE", path)).status, 409);
    // With that one closed the creator can make another
    assert.equal((await request(a, "POST", "/tournaments", { name: "Second try", time: 60, minutes: 10, startsAt: new Date().toISOString() })).status, 201);
  });

  test("a tournament needs two players to start, and is called off if they don't come", async () => {
    const startsAt = new Date(Date.now() - 1_000);
    const { tournament } = await app.tournaments.create(a.id, input());
    await app.pg.query(`UPDATE tournaments SET "startsAt" = $2 WHERE id = $1`, [tournament.id, startsAt]);
    const watching = await lobby(a, tournament.id);

    assert.equal(await app.tournaments.start(tournament.id), "scheduled");
    // Before its time nothing starts either, however many are in
    await app.tournaments.join(tournament.id, b.id);
    assert.equal(await app.tournaments.start(tournament.id, new Date(startsAt.getTime() - 60_000)), "scheduled");
    await app.tournaments.withdraw(tournament.id, b.id);

    assert.equal(await app.tournaments.start(tournament.id, new Date(startsAt.getTime() + START_GRACE_MS - 1)), "scheduled");
    assert.equal(await app.tournaments.start(tournament.id, new Date(startsAt.getTime() + START_GRACE_MS)), "cancelled");
    assert.equal((await watching.next("tournament")).data.tournament.status, "cancelled");
    assert.equal(app.tournaments.needsTick, false);
  });

  test("a whole tournament: start, pairings, scores, the next round, the end", async () => {
    const { tournament } = await app.tournaments.create(a.id, input());
    for (const player of [b, c, d]) await app.tournaments.join(tournament.id, player.id);
    const lobbies = new Map<number, TestSocket>();
    const inboxes = new Map<number, TestSocket>();
    for (const player of [a, b, c, d]) {
      lobbies.set(player.id, await lobby(player, tournament.id));
      inboxes.set(player.id, await open("/notifications", player));
    }
    assert.equal(app.tournaments.needsTick, true);

    // The tick starts it...
    await app.tournaments.tick();
    assert.equal((await lobbies.get(d.id)!.next("tournament")).data.tournament.status, "running");
    for (const player of [a, b, c, d]) assert.equal((await row(tournament.id, player)).waiting, true);

    // ...and the next one pairs everyone: neighbours in the standings, which
    // before any game is the order of their ids
    await app.tournaments.tick();
    const first = new Map<number, number>();
    for (const player of [a, b, c, d]) {
      const created = await inboxes.get(player.id)!.next("match_created");
      assert.equal(created.data.tournamentId, tournament.id);
      first.set(player.id, created.data.gameId);
      assert.equal((await row(tournament.id, player)).waiting, false);
    }
    assert.equal(first.get(a.id), first.get(b.id));
    assert.equal(first.get(c.id), first.get(d.id));
    assert.notEqual(first.get(a.id), first.get(c.id));
    // The lobby hears of the games too, for a player the other message missed
    const pairings = (await lobbies.get(d.id)!.next("pairings")).data.games;
    assert.deepEqual(
      pairings.map((g: any) => [g.id, [g.whiteId, g.blackId].sort()]).sort(),
      [
        [first.get(a.id), [a.id, b.id]],
        [first.get(c.id), [c.id, d.id]],
      ].sort()
    );
    const gameOne = await game(first.get(a.id)!);
    assert.deepEqual([gameOne.tournamentId, gameOne.rated, gameOne.status], [tournament.id, true, "in_progress"]);
    // Nobody is waiting: another pass starts nothing
    assert.deepEqual(await app.tournaments.pair(tournament.id), []);
    const live = (await request(a, "GET", `/tournaments/${tournament.id}`)).body;
    assert.equal(live.liveGames.length, 2);
    assert.equal(live.myGameId, first.get(a.id));

    // The game's own socket says what it scored
    const table = await open(`/game/${first.get(a.id)}`, a);
    assert.equal((await table.next("initial_game_state")).data.tournamentId, tournament.id);
    const one = await blackWins(first.get(a.id)!);
    const ended = await table.next("game_ended");
    assert.deepEqual(ended.tournament, {
      tournamentId: tournament.id,
      whitePoints: 0,
      blackPoints: 2,
    });
    assert.ok(ended.ratingChanges, "a tournament game is rated");
    const two = await blackWins(first.get(c.id)!);

    const winnerRow = await row(tournament.id, one.winner);
    assert.deepEqual(
      [winnerRow.score, winnerRow.streak, winnerRow.games, winnerRow.wins, winnerRow.sheet, winnerRow.waiting],
      [2, 1, 1, 1, "2", true]
    );
    const loserRow = await row(tournament.id, one.loser);
    assert.deepEqual([loserRow.score, loserRow.streak, loserRow.sheet, loserRow.waiting], [0, 0, "0", true]);
    assert.equal(loserRow.lastOpponentId, one.winner.id);
    assert.equal(loserRow.whites, 1);
    assert.equal(winnerRow.whites, 0);

    // The lobby hears the standings: both winners on top
    const standings = await lobbies.get(a.id)!.next("standings", (m) => m.data.standings[1]?.score === 2);
    assert.deepEqual(
      standings.data.standings.map((s: any) => s.score),
      [2, 2, 0, 0]
    );
    assert.equal(standings.data.standings[0].rank, 1);

    // Second round: the two winners meet, the two losers meet
    const second = await app.tournaments.pair(tournament.id);
    assert.equal(second.length, 2);
    for (const gameId of second) {
      const g = await game(gameId);
      const players = [g.whiteId, g.blackId].sort();
      assert.ok(
        String(players) === String([one.winner.id, two.winner.id].sort()) ||
          String(players) === String([one.loser.id, two.loser.id].sort()),
        `game ${gameId} pairs ${players}`
      );
    }

    // Time runs out with those games going: they are played out, then it closes
    await app.pg.query(`UPDATE tournaments SET "endsAt" = now() - interval '1 second' WHERE id = $1`, [tournament.id]);
    assert.equal(await app.tournaments.finish(tournament.id), false);
    await app.tournaments.tick();
    assert.equal((await request(a, "GET", `/tournaments/${tournament.id}`)).body.tournament.status, "running");
    const top = await blackWins(second[0]!);
    for (const gameId of second) {
      if ((await game(gameId)).status === "in_progress") await blackWins(gameId);
    }
    // A game that ended after the bell still scored, but nobody waits for another
    assert.equal((await row(tournament.id, top.winner)).waiting, false);
    assert.deepEqual(await app.tournaments.pair(tournament.id), []);

    await app.tournaments.tick();
    const final = (await request(b, "GET", `/tournaments/${tournament.id}`)).body;
    assert.equal(final.tournament.status, "finished");
    assert.equal(final.standings[0].score, 4);
    assert.deepEqual(final.tournament.winner.id, final.standings[0].userId);
    assert.equal(final.liveGames.length, 0);
    assert.equal((await lobbies.get(c.id)!.next("tournament", (m) => m.data.tournament.status === "finished")).data.tournament.winner.id, final.standings[0].userId);
    assert.equal(app.tournaments.needsTick, false);
    assert.deepEqual(await request(a, "POST", `/tournaments/${tournament.id}/join`).then((r) => r.body.code), "TOURNAMENT_CLOSED");
    // It moves from the open list to the finished one
    assert.deepEqual((await request(a, "GET", "/tournaments")).body.data, []);
    assert.equal((await request(a, "GET", "/tournaments?status=finished")).body.data[0].id, tournament.id);
    const page = (await request(a, "GET", `/tournaments/${tournament.id}/standings?limit=2&page=2`)).body;
    assert.deepEqual([page.data.length, page.data[0].rank, page.pagination.total], [2, 3, 4]);
  });

  test("only players with the lobby open are paired", async () => {
    const { id } = await running([a, b]);
    // c and d joined but never opened it
    await app.tournaments.join(id, c.id);
    await app.tournaments.join(id, d.id);
    const games = await app.tournaments.pair(id);
    assert.equal(games.length, 1);
    const g = await game(games[0]!);
    assert.deepEqual([g.whiteId, g.blackId].sort(), [a.id, b.id]);
    assert.equal((await row(id, c)).waiting, true);

    // They come in: now they get a game with each other
    await lobby(c, id);
    await lobby(d, id);
    assert.equal((await app.tournaments.pair(id)).length, 1);
  });

  test("two passes at once pair nobody twice", async () => {
    const { id } = await running();
    const results = await Promise.all([app.tournaments.pair(id), app.tournaments.pair(id), app.tournaments.pair(id)]);
    assert.equal(results.flat().length, 2);
    const { rows } = await app.pg.query(
      `SELECT "whiteId", "blackId" FROM games WHERE "tournamentId" = $1 AND status = 'in_progress'`,
      [id]
    );
    const players = rows.flatMap((g: any) => [g.whiteId, g.blackId]);
    assert.deepEqual(players.sort(), [a.id, b.id, c.id, d.id]);
  });

  test("someone playing another game isn't paired, nor two players with a block between them", async () => {
    const { id } = await running([a, b, c]);
    // c is in an ordinary game with d
    await app.pg.transact((tx) => createGame(tx, { whiteId: c.id, blackId: d.id, time: 180, increment: 0 }));
    await app.pg.query(`INSERT INTO user_blocks ("blockerId", "blockedId") VALUES ($1, $2)`, [a.id, b.id]);
    assert.deepEqual(await app.tournaments.pair(id), []);
    assert.equal((await row(id, a)).waiting, true);

    await app.pg.query(`DELETE FROM user_blocks`);
    const games = await app.tournaments.pair(id);
    assert.equal(games.length, 1);
    const g = await game(games[0]!);
    assert.deepEqual([g.whiteId, g.blackId].sort(), [a.id, b.id]);
  });

  test("a player in the matchmaking queue leaves it when the tournament pairs them", async () => {
    const { id } = await running([a, b]);
    await app.pg.query(`INSERT INTO matchmaking ("userId", rating, time, increment) VALUES ($1, 1500, 180, 0)`, [a.id]);
    assert.equal((await app.tournaments.pair(id)).length, 1);
    assert.equal((await app.pg.query(`SELECT 1 FROM matchmaking`)).rows.length, 0);
  });

  test("a player whose opponent can't be paired after all keeps their matchmaking search", async () => {
    const { id } = await running([a, b]);
    await app.pg.query(`INSERT INTO matchmaking ("userId", rating, time, increment) VALUES ($1, 1500, 180, 0)`, [a.id]);
    // b's game with d is being created (b's row locked, the game not yet
    // visible) while the pass pairs a with b
    let pass: Promise<number[]> | undefined;
    await app.pg.transact(async (tx) => {
      await createGame(tx, { whiteId: b.id, blackId: d.id, time: 180, increment: 0 });
      pass = app.tournaments.pair(id);
      await sleep(200);
    });
    assert.deepEqual(await pass, []);
    assert.equal((await app.pg.query(`SELECT 1 FROM matchmaking WHERE "userId" = $1`, [a.id])).rowCount, 1);
    assert.equal((await row(id, a)).waiting, true);
  });

  test("joining again while in keeps the player's place in the queue", async () => {
    const { id } = await running([a, b]);
    const since = async () =>
      (
        await app.pg.query(`SELECT "waitingSince" FROM tournament_players WHERE "tournamentId" = $1 AND "userId" = $2`, [
          id,
          a.id,
        ])
      ).rows[0].waitingSince.getTime();
    const before = await since();
    await app.tournaments.join(id, a.id, new Date(Date.now() + 60_000));
    assert.equal(await since(), before);
    // A paused player who comes back starts waiting then
    await app.tournaments.pause(id, a.id);
    const back = new Date(Date.now() + 60_000);
    await app.tournaments.join(id, a.id, back);
    assert.equal(await since(), back.getTime());
  });

  test("an instance that didn't create a tournament finds it within its refresh", async () => {
    const { tournament } = await app.tournaments.create(a.id, input());
    await app.tournaments.join(tournament.id, b.id);
    // Another instance: it knows of nothing yet, and has a socket attached
    const other = new TournamentService(app, app.hub);
    await open("/notifications", c);
    assert.equal(other.needsTick, false);
    await other.refreshOpen();
    assert.equal(other.needsTick, true);
    await other.tick();
    other.stop();
    assert.equal((await request(a, "GET", `/tournaments/${tournament.id}`)).body.tournament.status, "running");
  });

  test("not showing up loses the game, unrated, and pauses the absent player", async () => {
    const { id } = await running([a, b]);
    const [gameId] = await app.tournaments.pair(id);
    const before = [await blitz(a), await blitz(b)];
    const g = await game(gameId!);
    const absent = byId(g.whiteId);
    const there = byId(g.blackId);

    // The first-move window closes
    await app.pg.query(`UPDATE games SET "deadlineAt" = now() - interval '1 second' WHERE id = $1`, [gameId]);
    await app.liveGames.resolveDeadline(gameId!);

    const ended = await game(gameId!);
    assert.deepEqual(
      [ended.status, ended.result, ended.endReason, ended.rated, ended.whiteRatingChange, ended.blackRatingChange],
      ["finished", "black_win", "timeout", false, 0, 0]
    );
    assert.deepEqual([await blitz(a), await blitz(b)], before);

    const absentRow = await row(id, absent);
    assert.deepEqual([absentRow.status, absentRow.score, absentRow.sheet, absentRow.waiting], ["paused", 0, "0", false]);
    const thereRow = await row(id, there);
    assert.deepEqual([thereRow.status, thereRow.score, thereRow.sheet, thereRow.waiting], ["active", 2, "2", true]);

    // Paused: no more games until they say they're back
    assert.deepEqual(await app.tournaments.pair(id), []);
    await app.tournaments.join(id, absent.id);
    assert.equal((await app.tournaments.pair(id)).length, 1);
  });

  test("a tournament game has no abort, takeback, rematch or given time", async () => {
    const { id } = await running([a, b]);
    const [gameId] = await app.tournaments.pair(id);
    const g = await game(gameId!);
    const refused = async (action: Promise<unknown>) =>
      assert.equal(await action.then(() => "allowed", (error) => error.code), "TOURNAMENT_GAME");

    await refused(app.liveGames.abort(gameId!, g.whiteId));
    await refused(app.liveGames.giveTime(gameId!, g.whiteId));
    await app.liveGames.move(gameId!, g.whiteId, { from: "e2", to: "e4" });
    await app.liveGames.move(gameId!, g.blackId, { from: "e7", to: "e5" });
    await refused(app.liveGames.requestTakeback(gameId!, g.whiteId));
    // A draw can still be agreed
    await app.liveGames.offerDraw(gameId!, g.whiteId);
    await app.liveGames.respondToDraw(gameId!, g.blackId, true);
    await refused(app.liveGames.requestRematch(gameId!, g.whiteId));

    for (const player of [a, b]) {
      const r = await row(id, player);
      assert.deepEqual([r.score, r.draws, r.sheet, r.streak], [1, 1, "1", 0]);
    }
    // Just the two of them: they play each other again
    assert.equal((await app.tournaments.pair(id)).length, 1);
  });

  test("after a game there is a breather before the next pairing", async () => {
    tournamentTimings.requeueDelayMs = 5_000;
    try {
      const { id } = await running([a, b]);
      const [gameId] = await app.tournaments.pair(id);
      const ended = Date.now();
      await blackWins(gameId!);
      // Back in the queue, but not for the pass that runs right now
      assert.equal((await row(id, a)).waiting, true);
      assert.deepEqual(await app.tournaments.pair(id), []);
      assert.deepEqual(await app.tournaments.pair(id, new Date(ended + 4_000)), []);
      assert.equal((await app.tournaments.pair(id, new Date(Date.now() + 5_500))).length, 1);
    } finally {
      tournamentTimings.requeueDelayMs = 0;
    }
  });

  test("three wins in a row: the third counts double", async () => {
    const { id } = await running([a, b]);
    let streaker: User | null = null;
    for (let round = 0; round < 3; round++) {
      const [gameId] = await app.tournaments.pair(id);
      const g = await game(gameId!);
      streaker ??= byId(g.blackId);
      const loser = streaker.id === g.whiteId ? g.blackId : g.whiteId;
      await app.liveGames.move(gameId!, g.whiteId, { from: "e2", to: "e4" });
      await app.liveGames.move(gameId!, g.blackId, { from: "e7", to: "e5" });
      await app.liveGames.resign(gameId!, loser);
    }
    const r = await row(id, streaker!);
    assert.deepEqual([r.sheet, r.score, r.streak, r.wins], ["224", 8, 3, 3]);
    const me = (await request(streaker!, "GET", `/tournaments/${id}`)).body.me;
    assert.deepEqual([me.rank, me.score, me.streak, me.sheet], [1, 8, 3, "224"]);
    assert.ok(me.performance > 1500);
  });

  test("no game starts in the last minute, or in an unrated tournament changes a rating", async () => {
    const { id } = await running([a, b], { rated: false });
    const [gameId] = await app.tournaments.pair(id);
    assert.equal((await game(gameId!)).rated, false);
    const before = [await blitz(a), await blitz(b)];
    await blackWins(gameId!);
    assert.deepEqual([await blitz(a), await blitz(b)], before);

    await app.pg.query(`UPDATE tournaments SET "endsAt" = now() + interval '30 seconds' WHERE id = $1`, [id]);
    assert.deepEqual(await app.tournaments.pair(id), []);
    await app.pg.query(`UPDATE tournaments SET "endsAt" = now() + interval '5 minutes' WHERE id = $1`, [id]);
    assert.equal((await app.tournaments.pair(id)).length, 1);
  });

  test("leaving after playing keeps the score in the standings; a game under way still counts", async () => {
    const { id } = await running([a, b, c]);
    const [gameId] = await app.tournaments.pair(id);
    const g = await game(gameId!);
    const leaver = byId(g.blackId);
    await app.tournaments.withdraw(id, leaver.id);
    assert.equal((await row(id, leaver)).status, "withdrawn");
    await blackWins(gameId!);

    const left = await row(id, leaver);
    assert.deepEqual([left.status, left.score, left.waiting], ["withdrawn", 2, false]);
    const state = (await request(a, "GET", `/tournaments/${id}`)).body;
    assert.equal(state.tournament.playerCount, 2);
    assert.deepEqual([state.standings[0].userId, state.standings[0].status], [leaver.id, "withdrawn"]);
    assert.equal(state.standings.length, 3);
    // Coming back keeps what they scored
    await app.tournaments.join(id, leaver.id);
    assert.deepEqual([(await row(id, leaver)).score, (await request(a, "GET", `/tournaments/${id}`)).body.tournament.playerCount], [2, 3]);
  });

  test("a deleted account leaves its tournaments, and its unstarted one is called off", async () => {
    const { id } = await running([a, b, c]);
    const later = await app.tournaments.create(b.id, input({ name: "Boris's open", startsAt: new Date(Date.now() + 3600_000) }));
    const [gameId] = await app.tournaments.pair(id);
    const g = await game(gameId!);
    const paired = [g.whiteId, g.blackId];
    const leaver = byId(paired.includes(b.id) ? b.id : paired[0]!);
    const opponent = byId(paired.find((p) => p !== leaver.id)!);

    assert.equal((await request(leaver, "DELETE", "/users/me")).status, 204);
    assert.equal((await game(gameId!)).status, "finished");
    assert.equal((await row(id, leaver)).status, "withdrawn");
    assert.equal((await row(id, opponent)).score, 2);
    if (leaver.id === b.id) {
      assert.equal((await app.pg.query(`SELECT status FROM tournaments WHERE id = $1`, [later.tournament.id])).rows[0].status, "cancelled");
    }
    // The running one goes on without them
    assert.equal((await app.pg.query(`SELECT status, "playerCount" FROM tournaments WHERE id = $1`, [id])).rows[0].playerCount, 2);
  });

  test("an account being deleted can't slip back into a tournament, or leave one of its own behind", async () => {
    const { id } = await running([a, b, c]);
    const next = await app.tournaments.create(c.id, input({ name: "Clara's open", startsAt: new Date(Date.now() + 3600_000) }));
    // b joins both again, and sets up one of their own, in the moment after
    // the deletion has taken them out and before the account is gone
    const announce = app.tournaments.announceRemoval.bind(app.tournaments);
    let slippedIn = false;
    app.tournaments.announceRemoval = async (ids) => {
      if (!slippedIn) {
        slippedIn = true;
        await app.tournaments.join(id, b.id);
        await app.tournaments.join(next.tournament.id, b.id);
        await app.tournaments.create(b.id, input({ name: "Boris's last", startsAt: new Date(Date.now() + 3600_000) }));
      }
      return announce(ids);
    };
    try {
      assert.equal((await request(b, "DELETE", "/users/me")).status, 204);
    } finally {
      app.tournaments.announceRemoval = announce;
    }
    assert.equal(slippedIn, true);

    assert.equal((await row(id, b)).status, "withdrawn");
    assert.equal((await row(next.tournament.id, b)).status, "withdrawn");
    const { rows } = await app.pg.query(
      `SELECT t.id, t.status, t."playerCount",
         (SELECT count(*)::int FROM tournament_players p WHERE p."tournamentId" = t.id AND p.status <> 'withdrawn') AS "in"
       FROM tournaments t ORDER BY t.id`
    );
    assert.deepEqual(
      rows.map((t: any) => [t.status, t.playerCount, t.in]),
      [
        ["running", 2, 2],
        ["scheduled", 1, 1],
        // Their own, made while they were on the way out: called off (a
        // cancelled tournament keeps its list of who had joined)
        ["cancelled", 1, 1],
      ]
    );
    // Once the account is gone nothing lets it in again
    const code = (action: Promise<unknown>) => action.then(() => "allowed", (error) => error.code);
    assert.equal(await code(app.tournaments.join(id, b.id)), "USER_NOT_FOUND");
    assert.equal(await code(app.tournaments.create(b.id, input({ name: "From beyond" }))), "USER_NOT_FOUND");
    assert.equal((await row(id, b)).status, "withdrawn");
    assert.equal((await app.pg.query(`SELECT 1 FROM tournaments WHERE status IN ('scheduled', 'running') AND "createdBy" = $1`, [b.id])).rows.length, 0);
  });

  test("the lobby socket answers sync and refuses a tournament that isn't there", async () => {
    const { tournament } = await app.tournaments.create(a.id, input({ startsAt: new Date(Date.now() + 600_000) }));
    const socket = await open(`/tournament/${tournament.id}`, b);
    const state = await socket.next("state");
    assert.deepEqual([state.data.tournament.id, state.data.me, state.data.standings.length], [tournament.id, null, 1]);
    // Someone joins: everyone in the lobby gets the new standings
    await app.tournaments.join(tournament.id, b.id);
    const joined = (await socket.next("standings")).data;
    // Whose own line changed, for players too far down to see it in the message
    assert.deepEqual([joined.playerCount, joined.changed], [2, [b.id]]);
    socket.send({ type: "sync" });
    assert.equal((await socket.next("state")).data.me.userId, b.id);

    const missing = await open("/tournament/999", b);
    assert.equal((await missing.next("error")).data.code, "TOURNAMENT_NOT_FOUND");
  });

  test("a player can create only so many tournaments a day", async () => {
    const later = input({ name: "Again and again", startsAt: new Date(Date.now() + 600_000) });
    const code = (action: Promise<unknown>) => action.then(() => "created", (error) => error.code);
    // Through the service: the route has its own limit per minute
    for (let n = 0; n < TOURNAMENTS_PER_DAY.max; n++) {
      const { tournament } = await app.tournaments.create(a.id, later);
      // One refused for being a second open one doesn't use up the day's count
      assert.equal(await code(app.tournaments.create(a.id, later)), "TOURNAMENT_LIMIT");
      await app.tournaments.cancel(tournament.id, a.id);
    }
    const over = await request(a, "POST", "/tournaments", {
      name: "One too many",
      time: 180,
      minutes: 30,
      startsAt: later.startsAt.toISOString(),
    });
    assert.deepEqual([over.status, over.body.code], [429, "TOURNAMENT_RATE_LIMITED"]);
    // Refused whole: nothing of it is left behind
    assert.equal((await app.pg.query(`SELECT 1 FROM tournaments WHERE status = 'scheduled'`)).rows.length, 0);
    assert.equal((await app.pg.query(`SELECT 1 FROM tournaments`)).rows.length, TOURNAMENTS_PER_DAY.max);
    assert.equal((await app.pg.query(`SELECT 1 FROM tournament_players`)).rows.length, TOURNAMENTS_PER_DAY.max);
    // Someone else's count is their own
    assert.equal(await code(app.tournaments.create(b.id, later)), "created");
  });

  test("the standings name the players whose line changed, and a player can ask for just their own", async () => {
    const { id, lobbies } = await running([a, b]);
    const [gameId] = await app.tournaments.pair(id);
    const mine = async (user: User) => (await request(user, "GET", `/tournaments/${id}/me`)).body;
    assert.deepEqual([(await mine(a)).me.userId, (await mine(a)).myGameId], [a.id, gameId]);

    const { winner, loser } = await blackWins(gameId!);
    const after = await lobbies.get(a.id)!.next("standings", (m) => m.data.changed.includes(winner.id));
    assert.deepEqual([...after.data.changed].sort(), [a.id, b.id].sort());
    assert.deepEqual(
      [(await mine(winner)).me.score, (await mine(winner)).me.rank, (await mine(winner)).myGameId],
      [2, 1, null]
    );
    assert.deepEqual([(await mine(loser)).me.score, (await mine(loser)).me.rank], [0, 2]);
    // A change that is nobody's own line (a new pairing) names nobody
    await app.tournaments.pair(id);
    assert.deepEqual((await lobbies.get(b.id)!.next("standings", (m) => m.data.liveGames.length === 1)).data.changed, []);

    // Someone who isn't in it has no line; no tournament, no answer
    assert.deepEqual(await mine(c), { me: null, myGameId: null });
    assert.equal((await request(a, "GET", "/tournaments/999/me")).status, 404);
    assert.equal((await request(null, "GET", `/tournaments/${id}/me`)).status, 401);
  });

  test("a failed startup read of the open tournaments is tried again by the tick", async () => {
    const { tournament } = await app.tournaments.create(a.id, input());
    await app.tournaments.join(tournament.id, b.id);
    // A restart: this instance knows of nothing, and the database isn't answering yet
    app.tournaments.clear();
    const findOpen = tournamentRepository.findOpen;
    tournamentRepository.findOpen = async () => {
      throw new Error("the database is waking up");
    };
    try {
      await assert.rejects(app.tournaments.loadOpen());
      assert.equal(app.tournaments.needsTick, true, "the tick keeps running to try again");
      await assert.rejects(app.tournaments.tick());
    } finally {
      tournamentRepository.findOpen = findOpen;
    }
    // The database is back: the next tick reads them and starts the one that is due
    await app.tournaments.tick();
    assert.equal((await request(a, "GET", `/tournaments/${tournament.id}`)).body.tournament.status, "running");
    assert.equal(app.tournaments.needsTick, true);
  });

  test("a first move that comes after its deadline loses the game instead of aborting it", async () => {
    for (const mover of ["white", "black"] as const) {
      const { id } = await running([a, b]);
      const [gameId] = await app.tournaments.pair(id);
      const g = await game(gameId!);
      if (mover === "black") await app.liveGames.move(gameId!, g.whiteId, { from: "e2", to: "e4" });
      // The window for the first move has closed, and the timer hasn't fired yet
      await app.pg.query(`UPDATE games SET "deadlineAt" = now() - interval '1 second' WHERE id = $1`, [gameId]);
      const late = byId(mover === "white" ? g.whiteId : g.blackId);
      const there = byId(mover === "white" ? g.blackId : g.whiteId);
      await app.liveGames.move(gameId!, late.id, mover === "white" ? { from: "e2", to: "e4" } : { from: "e7", to: "e5" });

      const ended = await game(gameId!);
      assert.deepEqual(
        [ended.status, ended.result, ended.endReason, ended.rated],
        ["finished", mover === "white" ? "black_win" : "white_win", "timeout", false],
        `${mover} moved late`
      );
      const lateRow = await row(id, late);
      assert.deepEqual([lateRow.status, lateRow.score, lateRow.sheet, lateRow.waiting], ["paused", 0, "0", false]);
      const thereRow = await row(id, there);
      assert.deepEqual([thereRow.status, thereRow.score, thereRow.sheet], ["active", 2, "2"]);

      await Promise.all(sockets.splice(0).map((s) => s.close()));
      await resetDb(app);
      a = await createUser(app, "anna", 1500);
      b = await createUser(app, "boris", 1450);
    }
  });

  test("a lobby socket that closes while it is being opened doesn't count as here", async () => {
    const { tournament } = await app.tournaments.create(a.id, input());
    const find = tournamentRepository.find;
    // The lookup the socket route waits for takes a moment, as it does on a busy database
    tournamentRepository.find = async (db, id) => {
      await sleep(150);
      return find(db, id);
    };
    try {
      const ws = new WebSocket(`ws://${baseUrl}/api/ws/tournament/${tournament.id}`, ["gambitio", `auth.${a.clerkId}`]);
      await new Promise<void>((resolve, reject) => {
        ws.once("open", () => resolve());
        ws.once("error", reject);
      });
      ws.terminate();
      await sleep(500);
    } finally {
      tournamentRepository.find = find;
    }
    assert.deepEqual(await app.hub.memberUserIds(tournamentPresenceKey(tournament.id)), []);
    assert.equal(app.hub.attachedCount, 0);
  });

  test("games ending while players join, pause and leave: no deadlock, and the standings add up", async () => {
    // Eight players, so several games end in the same moment
    const players = [a, b, c, d];
    for (const name of ["elena", "fedor", "galina", "henrik"]) players.push(await createUser(app, name, 1300));
    const { tournament } = await app.tournaments.create(a.id, input());
    const id = tournament.id;
    for (const player of players.slice(1)) await app.tournaments.join(id, player.id);
    for (const player of players) await lobby(player, id);
    assert.equal(await app.tournaments.start(id), "running");

    const errors: string[] = [];
    /** Runs in the background of a round; `expected` are refusals that are part of the game */
    const attempt = (action: Promise<unknown>, expected: string[] = []) =>
      action.catch((error) => {
        if (!expected.includes(error?.code)) errors.push(`${error?.code}: ${error?.message}`);
      });
    const pick = (n: number) => Math.floor(Math.random() * n);

    for (let round = 0; round < 15; round++) {
      await app.tournaments.pair(id);
      const { rows: live } = await app.pg.query(
        `SELECT id, "whiteId", "blackId" FROM games WHERE "tournamentId" = $1 AND status = 'in_progress'`,
        [id]
      );
      const work: Promise<unknown>[] = [];
      for (const g of live) {
        const how = pick(4);
        work.push(
          attempt(
            (async () => {
              // Before both have moved: the game row is written twice in the
              // ending transaction (unrated, then finished)...
              if (how === 0) return app.liveGames.resign(g.id, g.whiteId);
              if (how === 1) {
                await app.pg.query(`UPDATE games SET "deadlineAt" = now() - interval '1 second' WHERE id = $1`, [g.id]);
                return app.liveGames.resolveDeadline(g.id);
              }
              if (how === 2) {
                // ...and so it is by a move that ends the game (fool's mate)
                await app.liveGames.move(g.id, g.whiteId, { from: "f2", to: "f3" });
                await app.liveGames.move(g.id, g.blackId, { from: "e7", to: "e5" });
                await app.liveGames.move(g.id, g.whiteId, { from: "g2", to: "g4" });
                return app.liveGames.move(g.id, g.blackId, { from: "d8", to: "h4" });
              }
              await app.liveGames.move(g.id, g.whiteId, { from: "e2", to: "e4" });
              await app.liveGames.move(g.id, g.blackId, { from: "e7", to: "e5" });
              return app.liveGames.resign(g.id, g.blackId);
            })(),
            ["GAME_OVER"]
          )
        );
        // Its own players join again, pause or leave as it ends
        for (const userId of [g.whiteId, g.blackId]) {
          const what = pick(3);
          work.push(
            attempt(
              what === 0
                ? app.tournaments.join(id, userId)
                : what === 1
                  ? app.tournaments.pause(id, userId)
                  : app.tournaments.withdraw(id, userId),
              ["NOT_IN_TOURNAMENT"]
            )
          );
        }
      }
      work.push(attempt(app.tournaments.pair(id)), attempt(app.tournaments.tick()));
      await Promise.all(work);
      // Everyone back in for the next round
      for (const player of players) await attempt(app.tournaments.join(id, player.id));
    }
    assert.deepEqual(errors, []);

    const { rows } = await app.pg.query(
      `SELECT p."userId", p.score, p.games, p.wins, p.draws, p.sheet, p.whites,
         (SELECT count(*)::int FROM games g WHERE g."tournamentId" = p."tournamentId" AND g.status = 'finished'
            AND (g."whiteId" = p."userId" OR g."blackId" = p."userId")) AS played,
         (SELECT count(*)::int FROM games g WHERE g."tournamentId" = p."tournamentId"
            AND g."winnerId" = p."userId") AS won,
         (SELECT count(*)::int FROM games g WHERE g."tournamentId" = p."tournamentId" AND g.result = 'draw'
            AND (g."whiteId" = p."userId" OR g."blackId" = p."userId")) AS drawn,
         (SELECT count(*)::int FROM games g WHERE g."tournamentId" = p."tournamentId"
            AND g."whiteId" = p."userId") AS white
       FROM tournament_players p WHERE p."tournamentId" = $1`,
      [id]
    );
    // Nobody's row went missing while they were playing
    assert.equal(rows.length, players.length);
    let played = 0;
    for (const p of rows) {
      assert.deepEqual([p.games, p.wins, p.draws, p.whites], [p.played, p.won, p.drawn, p.white], `player ${p.userId}`);
      assert.equal(p.score, [...p.sheet].reduce((sum: number, digit: string) => sum + Number(digit), 0));
      played += p.games;
    }
    assert.ok(played > 20, `only ${played / 2} games were played`);
    const { rows: check } = await app.pg.query(
      `SELECT t."playerCount",
         (SELECT count(*)::int FROM tournament_players p WHERE p."tournamentId" = t.id AND p.status <> 'withdrawn') AS "in",
         (SELECT count(*)::int FROM games g WHERE g."tournamentId" = t.id AND g.result = 'aborted') AS aborted,
         (SELECT count(*)::int FROM (
            SELECT "whiteId" AS u FROM games WHERE status = 'in_progress'
            UNION ALL SELECT "blackId" FROM games WHERE status = 'in_progress') g
          GROUP BY u HAVING count(*) > 1 LIMIT 1) AS "inTwoGames"
       FROM tournaments t WHERE t.id = $1`,
      [id]
    );
    assert.deepEqual(check[0], { playerCount: check[0].in, in: check[0].in, aborted: 0, inTwoGames: null });
  });
});
