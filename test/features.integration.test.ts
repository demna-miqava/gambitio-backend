import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import type { FastifyInstance } from "fastify";
import { connect, createUser, integrationEnabled, resetDb, startTestApp, type TestSocket } from "./helpers.js";

const skip = !integrationEnabled && "TEST_POSTGRES_URL / TEST_REDIS_URL not set";

describe("series, repertoire, study rooms and endgames", { skip }, () => {
  let app: FastifyInstance;
  let baseUrl: string;
  let alice: { id: number; clerkId: string };
  let bob: { id: number; clerkId: string };
  const sockets: TestSocket[] = [];

  const open = async (path: string, clerkId: string) => {
    const socket = await connect(baseUrl, path, clerkId);
    sockets.push(socket);
    return socket;
  };

  const request = (method: "GET" | "POST" | "PATCH" | "DELETE", url: string, clerkId: string, payload?: object) =>
    app.inject({
      method,
      url,
      headers: { authorization: `Bearer ${clerkId}` },
      ...(payload && { payload }),
    });

  const befriend = (a: number, b: number) =>
    app.pg.query(`INSERT INTO friends ("userOneId", "userTwoId") VALUES ($1, $2)`, [a, b]);

  before(async () => {
    ({ app, baseUrl } = await startTestApp());
  });
  after(async () => {
    await app.close();
  });
  beforeEach(async () => {
    await Promise.all(sockets.splice(0).map((s) => s.close()));
    await resetDb(app);
    alice = await createUser(app, "alice");
    bob = await createUser(app, "bobby");
  });

  describe("series", () => {
    const gameRow = async (gameId: number) =>
      (await app.pg.query(`SELECT "whiteId", "blackId", "seriesId", "seriesGame" FROM games WHERE id = $1`, [gameId]))
        .rows[0];

    test("a best of three alternates colours, keeps score and ends", async () => {
      await befriend(alice.id, bob.id);
      const na = await open("/notifications", alice.clerkId);
      const nb = await open("/notifications", bob.clerkId);
      na.send({
        type: "challenge_sent",
        data: { challengedId: bob.id, color: "white", time: 180, increment: 0, bestOf: 3 },
      });
      const received = await nb.next("challenge_received");
      assert.equal(received.data.bestOf, 3);
      const listed = (await request("GET", "/api/challenges", bob.clerkId)).json();
      assert.equal(listed.challenges[0].bestOf, 3);

      nb.send({ type: "challenge_accepted", data: { challengerId: alice.id } });
      const created = await na.next("match_created");
      let gameId: number = created.data.gameId;
      const first = await gameRow(gameId);
      assert.deepEqual([first.whiteId, first.blackId, first.seriesGame], [alice.id, bob.id, 1]);
      const seriesId: number = first.seriesId;

      // Game 1: Alice resigns
      let ga = await open(`/game/${gameId}`, alice.clerkId);
      let gb = await open(`/game/${gameId}`, bob.clerkId);
      const state = await ga.next("initial_game_state");
      assert.equal(state.data.series.bestOf, 3);
      assert.equal(state.data.seriesGame, 1);
      await gb.next("initial_game_state");
      ga.send({ type: "resign" });
      let ended = await ga.next("game_ended");
      assert.equal(ended.series.playerTwo.score, 1);
      assert.equal(ended.series.status, "active");
      assert.deepEqual(ended.series.next, { number: 2, whiteId: bob.id, blackId: alice.id });

      // Bob asks for the next game, Alice accepts
      gb.send({ type: "rematch_request" });
      await ga.next("rematch_request");
      ga.send({ type: "rematch_response", data: { accepted: true } });
      gameId = (await ga.next("match_found")).data.gameId;
      const second = await gameRow(gameId);
      assert.deepEqual([second.whiteId, second.blackId, second.seriesGame, second.seriesId], [bob.id, alice.id, 2, seriesId]);

      // Resigning the series isn't allowed mid-game
      const midGame = await request("POST", `/api/series/${seriesId}/resign`, bob.clerkId);
      assert.equal(midGame.statusCode, 409);

      // Game 2: Bob resigns (1 - 1)
      ga = await open(`/game/${gameId}`, alice.clerkId);
      gb = await open(`/game/${gameId}`, bob.clerkId);
      await ga.next("initial_game_state");
      await gb.next("initial_game_state");
      gb.send({ type: "resign" });
      ended = await ga.next("game_ended");
      assert.deepEqual([ended.series.playerOne.score, ended.series.playerTwo.score], [1, 1]);

      ga.send({ type: "rematch_request" });
      await gb.next("rematch_request");
      gb.send({ type: "rematch_response", data: { accepted: true } });
      gameId = (await gb.next("match_found")).data.gameId;
      const third = await gameRow(gameId);
      assert.deepEqual([third.whiteId, third.seriesGame], [alice.id, 3]);

      // Game 3: Alice resigns, Bob takes the series 2 - 1
      ga = await open(`/game/${gameId}`, alice.clerkId);
      await ga.next("initial_game_state");
      ga.send({ type: "resign" });
      ended = await ga.next("game_ended");
      assert.equal(ended.series.status, "finished");
      assert.equal(ended.series.winnerId, bob.id);
      assert.equal(ended.series.endReason, "played_out");
      assert.equal(ended.series.next, null);

      const detail = (await request("GET", `/api/series/${seriesId}`, alice.clerkId)).json();
      assert.equal(detail.games.length, 3);
      assert.deepEqual(detail.games.map((g: any) => g.seriesGame), [1, 2, 3]);
      assert.equal(detail.liveGameId, null);

      // A rematch after the series is an ordinary game
      gb = await open(`/game/${gameId}`, bob.clerkId);
      await gb.next("initial_game_state");
      gb.send({ type: "rematch_request" });
      await ga.next("rematch_request");
      ga.send({ type: "rematch_response", data: { accepted: true } });
      const after = await gameRow((await ga.next("match_found")).data.gameId);
      assert.equal(after.seriesId, null);
      assert.deepEqual([after.whiteId, after.blackId], [bob.id, alice.id]);

      // Head to head, from Alice's side: 1 win, 2 losses, 1 series lost
      await app.liveGames.abort((await app.pg.query(`SELECT id FROM games WHERE status = 'in_progress'`)).rows[0].id, alice.id);
      const h2h = (await request("GET", `/api/users/${bob.id}/head-to-head`, alice.clerkId)).json();
      assert.deepEqual([h2h.wins, h2h.draws, h2h.losses], [1, 0, 2]);
      assert.deepEqual(h2h.series, { won: 0, lost: 1, drawn: 0, active: 0 });
      assert.equal(h2h.recentGames.length, 3);
      const listing = (await request("GET", `/api/users/${alice.id}/series`, bob.clerkId)).json();
      assert.equal(listing.data[0].id, seriesId);
    });

    test("a series can be resigned between games", async () => {
      await befriend(alice.id, bob.id);
      const na = await open("/notifications", alice.clerkId);
      const nb = await open("/notifications", bob.clerkId);
      na.send({
        type: "challenge_sent",
        data: { challengedId: bob.id, color: "black", time: 60, increment: 0, bestOf: 5 },
      });
      await nb.next("challenge_received");
      nb.send({ type: "challenge_accepted", data: { challengerId: alice.id } });
      const gameId = (await na.next("match_created")).data.gameId;
      const game = (await app.pg.query(`SELECT "whiteId", "seriesId" FROM games WHERE id = $1`, [gameId])).rows[0];
      assert.equal(game.whiteId, bob.id); // Alice chose black for game one
      await app.liveGames.abort(gameId, bob.id);

      const outsider = await createUser(app, "carol");
      assert.equal((await request("POST", `/api/series/${game.seriesId}/resign`, outsider.clerkId)).statusCode, 403);
      const res = await request("POST", `/api/series/${game.seriesId}/resign`, bob.clerkId);
      assert.equal(res.statusCode, 200);
      assert.equal(res.json().series.winnerId, alice.id);
      assert.equal(res.json().series.endReason, "resignation");
      // The aborted game didn't count
      assert.equal(res.json().series.gamesPlayed, 0);
      assert.equal((await na.next("series_updated")).data.series.status, "finished");
      assert.equal((await request("POST", `/api/series/${game.seriesId}/resign`, bob.clerkId)).statusCode, 409);
    });
  });

  describe("series continuation and expiry", () => {
    const startSeries = async () => {
      await befriend(alice.id, bob.id);
      const na = await open("/notifications", alice.clerkId);
      const nb = await open("/notifications", bob.clerkId);
      na.send({
        type: "challenge_sent",
        data: { challengedId: bob.id, color: "black", time: 60, increment: 0, bestOf: 3 },
      });
      await nb.next("challenge_received");
      nb.send({ type: "challenge_accepted", data: { challengerId: alice.id } });
      const gameId: number = (await na.next("match_created")).data.gameId;
      const { seriesId } = (await app.pg.query(`SELECT "seriesId" FROM games WHERE id = $1`, [gameId])).rows[0];
      return { na, nb, gameId, seriesId: seriesId as number };
    };

    test("the next game can be started from the series page by a challenge", async () => {
      const { na, nb, gameId, seriesId } = await startSeries();
      // Not while game 1 is being played
      na.send({
        type: "challenge_sent",
        data: { challengedId: bob.id, color: "white", time: 600, increment: 5, seriesId },
      });
      assert.equal((await na.next("error")).data.code, "SERIES_GAME_IN_PROGRESS");
      await app.liveGames.resign(gameId, bob.id); // Bob (white) resigns game 1

      // Nobody else can continue it, and only against the series opponent
      const carol = await createUser(app, "carol");
      await befriend(alice.id, carol.id);
      const nc = await open("/notifications", carol.clerkId);
      nc.send({ type: "challenge_sent", data: { challengedId: alice.id, color: "white", time: 60, increment: 0, seriesId } });
      assert.equal((await nc.next("error")).data.code, "NOT_IN_SERIES");
      na.send({ type: "challenge_sent", data: { challengedId: carol.id, color: "white", time: 60, increment: 0, seriesId } });
      assert.equal((await na.next("error")).data.code, "NOT_IN_SERIES");

      // The series' own settings apply, whatever was sent: 1+0, game 2, Alice white
      na.send({
        type: "challenge_sent",
        data: { challengedId: bob.id, color: "black", time: 600, increment: 5, seriesId },
      });
      const received = await nb.next("challenge_received");
      assert.deepEqual(
        [received.data.time, received.data.increment, received.data.bestOf, received.data.seriesId, received.data.seriesGame, received.data.color],
        [60, 0, 3, seriesId, 2, "black"]
      );
      const listed = (await request("GET", "/api/challenges", bob.clerkId)).json().challenges[0];
      assert.deepEqual([listed.seriesId, listed.seriesGame], [seriesId, 2]);
      const sent = (await request("GET", "/api/challenges/sent", alice.clerkId)).json().challenge;
      assert.deepEqual([sent.seriesId, sent.seriesGame, sent.time], [seriesId, 2, 60]);

      nb.send({ type: "challenge_accepted", data: { challengerId: alice.id } });
      const second = (await na.next("match_created")).data.gameId;
      const row = (
        await app.pg.query(`SELECT "whiteId", "blackId", "seriesId", "seriesGame", time FROM games WHERE id = $1`, [second])
      ).rows[0];
      assert.deepEqual(row, { whiteId: alice.id, blackId: bob.id, seriesId, seriesGame: 2, time: 60 });
      const detail = (await request("GET", `/api/series/${seriesId}`, alice.clerkId)).json();
      assert.equal(detail.liveGameId, second);
    });

    test("resigning a series withdraws the challenge to continue it", async () => {
      const { na, nb, gameId, seriesId } = await startSeries();
      await app.liveGames.resign(gameId, bob.id);
      na.send({ type: "challenge_sent", data: { challengedId: bob.id, color: "white", time: 60, increment: 0, seriesId } });
      await nb.next("challenge_received");
      assert.equal((await request("POST", `/api/series/${seriesId}/resign`, bob.clerkId)).statusCode, 200);
      await nb.next("challenge_cancelled");
      assert.equal((await na.next("challenge_declined")).data.reason, "expired");
      assert.equal((await app.pg.query(`SELECT 1 FROM challenges`)).rows.length, 0);
      // A stale continuation of a finished series can't start a game either
      await app.pg.query(
        `INSERT INTO challenges ("challengerId", "challengedId", "challengerUsername", time, increment, "seriesId")
         VALUES ($1, $2, 'alice', 60, 0, $3)`,
        [alice.id, bob.id, seriesId]
      );
      nb.send({ type: "challenge_accepted", data: { challengerId: alice.id } });
      assert.equal((await nb.next("error")).data.code, "SERIES_OVER");
    });

    test("series nobody plays on expire, to the leader on points", async () => {
      const insert = async (one: number, two: number, daysOld: number) =>
        (
          await app.pg.query<{ id: number }>(
            `INSERT INTO series ("playerOneId", "playerTwoId", "playerOneStartsWhite", "bestOf", time,
               "playerOneHalfPoints", "playerTwoHalfPoints", "gamesPlayed", "createdAt")
             VALUES ($1, $2, true, 5, 180, $3, $4, $5, now() - make_interval(days => $6)) RETURNING id`,
            [alice.id, bob.id, one, two, (one + two) / 2, daysOld]
          )
        ).rows[0]!.id;
      const led = await insert(3, 1, 8);
      const level = await insert(2, 2, 8);
      const fresh = await insert(3, 1, 2);
      // An old series whose last game was recent is still being played
      const recent = await insert(2, 0, 20);
      await app.pg.query(
        `INSERT INTO games ("whiteId", "blackId", "whiteUsername", "blackUsername", "whiteRating", "blackRating",
           time, increment, status, result, "numMoves", "whiteTimeLeftMs", "blackTimeLeftMs", "endedAt", "seriesId", "seriesGame")
         VALUES ($1, $2, 'alice', 'bobby', 1200, 1200, 180, 0, 'finished', 'white_win', 2, 1000, 1000, now() - interval '1 day', $3, 1)`,
        [alice.id, bob.id, recent]
      );
      const na = await open("/notifications", alice.clerkId);

      await app.series.expireStale();
      const status = async (id: number) =>
        (await app.pg.query(`SELECT status, "winnerId", "endReason" FROM series WHERE id = $1`, [id])).rows[0];
      assert.deepEqual(await status(led), { status: "finished", winnerId: alice.id, endReason: "expired" });
      assert.deepEqual(await status(level), { status: "finished", winnerId: null, endReason: "expired" });
      assert.equal((await status(fresh)).status, "active");
      assert.equal((await status(recent)).status, "active");
      const updated = await na.next("series_updated");
      assert.equal(updated.data.series.endReason, "expired");
      // Running again changes nothing
      await app.series.expireStale();
      assert.equal(na.messages.filter((m) => m.type === "series_updated").length, 2);
    });
  });

  test("deleting an account ends their unfinished series", async () => {
    const { rows } = await app.pg.query(
      `INSERT INTO series ("playerOneId", "playerTwoId", "playerOneStartsWhite", "bestOf", time)
       VALUES ($1, $2, true, 3, 180) RETURNING id`,
      [alice.id, bob.id]
    );
    await app.inject({ method: "DELETE", url: "/api/users/me", headers: { authorization: `Bearer ${alice.clerkId}` } });
    const series = (await app.pg.query(`SELECT status, "winnerId" FROM series WHERE id = $1`, [rows[0].id])).rows[0];
    assert.deepEqual(series, { status: "finished", winnerId: bob.id });
  });

  describe("repertoire", () => {
    test("lines are normalised, practised and compared with games", async () => {
      const created = await request("POST", "/api/repertoire", alice.clerkId, {
        color: "white",
        name: "Italian",
        moves: ["e4", "e5", "Ng1f3", "Nc6", "Bc4"],
      });
      assert.equal(created.statusCode, 201);
      const line = created.json().line;
      assert.deepEqual(line.moves, ["e4", "e5", "Nf3", "Nc6", "Bc4"]);

      const dup = await request("POST", "/api/repertoire", alice.clerkId, {
        color: "white",
        name: "Again",
        moves: ["e4", "e5", "Nf3", "Nc6", "Bc4"],
      });
      assert.equal(dup.json().code, "LINE_EXISTS");
      const illegal = await request("POST", "/api/repertoire", alice.clerkId, {
        color: "white",
        name: "Bad",
        moves: ["e4", "Ke2"],
      });
      assert.equal(illegal.json().code, "INVALID_LINE");

      const renamed = await request("PATCH", `/api/repertoire/${line.id}`, alice.clerkId, { name: "Giuoco" });
      assert.equal(renamed.json().line.name, "Giuoco");
      // Not someone else's
      assert.equal((await request("PATCH", `/api/repertoire/${line.id}`, bob.clerkId, { name: "x" })).statusCode, 404);

      const practised = (await request("POST", `/api/repertoire/${line.id}/practice`, alice.clerkId, { correct: true })).json().line;
      assert.equal(practised.streak, 1);
      assert.equal(practised.practiceCorrect, 1);
      assert.ok(new Date(practised.dueAt).getTime() > Date.now());
      const missed = (await request("POST", `/api/repertoire/${line.id}/practice`, alice.clerkId, { correct: false })).json().line;
      assert.deepEqual([missed.streak, missed.practiceAttempts, missed.practiceCorrect], [0, 2, 1]);

      // A bot game where Alice played 2.Bc4 instead of 2.Nf3
      const saved = await request("POST", "/api/games/bot", alice.clerkId, {
        botId: "casual-bot",
        color: "white",
        pgn: "1. e4 e5 2. Bc4 Nf6",
        endReason: "resignation",
      });
      assert.equal(saved.statusCode, 201);
      const check = (await request("GET", "/api/repertoire/check", alice.clerkId)).json().games;
      assert.equal(check.length, 1);
      assert.equal(check[0].status, "you_deviated");
      assert.equal(check[0].divergence.played, "Bc4");
      assert.deepEqual(check[0].divergence.expected, ["Nf3"]);
      assert.deepEqual(check[0].divergence.lineNames, ["Giuoco"]);
      assert.equal(check[0].outcome, "loss");

      assert.equal((await request("DELETE", `/api/repertoire/${line.id}`, alice.clerkId)).statusCode, 204);
      assert.deepEqual((await request("GET", "/api/repertoire", alice.clerkId)).json().lines, []);
    });
  });

  describe("study rooms", () => {
    test("friends explore one board together", async () => {
      const created = await request("POST", "/api/study", alice.clerkId, { name: "Review", moves: ["e4", "e5"] });
      assert.equal(created.statusCode, 201);
      const roomId: number = created.json().room.id;

      // Only friends can be invited, and non-members can't look in
      assert.equal((await request("POST", `/api/study/${roomId}/members`, alice.clerkId, { userId: bob.id })).statusCode, 403);
      assert.equal((await request("GET", `/api/study/${roomId}`, bob.clerkId)).statusCode, 404);
      const outsider = await open(`/study/${roomId}`, bob.clerkId);
      assert.equal((await outsider.next("error")).data.code, "STUDY_NOT_FOUND");

      await befriend(alice.id, bob.id);
      const nb = await open("/notifications", bob.clerkId);
      const invited = await request("POST", `/api/study/${roomId}/members`, alice.clerkId, { userId: bob.id });
      assert.equal(invited.statusCode, 201);
      assert.equal((await nb.next("study_invite")).data.roomId, roomId);

      const sa = await open(`/study/${roomId}`, alice.clerkId);
      const initial = await sa.next("study_state");
      assert.equal(initial.room.version, 0);
      assert.equal(initial.members.length, 2);
      assert.equal(Object.keys(initial.state.nodes).length, 3);

      const sb = await open(`/study/${roomId}`, bob.clerkId);
      await sb.next("study_state");
      await sa.next("presence", (m) => m.userIds.length === 2);

      // Bob plays a variation from the start: everyone gets just the new move
      sb.send({ type: "move", nodeId: "root", uci: "d2d4" });
      const added = await sa.next("node_added");
      assert.equal(added.version, 1);
      assert.equal(added.by, bob.id);
      assert.equal(added.node.san, "d4");
      assert.equal(added.node.parentId, "root");
      const d4: string = added.cursor;
      assert.equal(added.node.id, d4);
      // Promoting it reorders the root's children; deleting a move names it
      sb.send({ type: "promote", nodeId: d4 });
      const children = await sa.next("children");
      assert.deepEqual([children.parentId, children.children[0]], ["root", d4]);
      sb.send({ type: "move", nodeId: d4, uci: "d7d5" });
      const d5: string = (await sa.next("node_added")).cursor;
      sa.send({ type: "delete", nodeId: d5 });
      const deleted = await sb.next("node_deleted");
      assert.deepEqual([deleted.nodeId, deleted.parentId, deleted.cursor], [d5, d4, d4]);
      assert.equal(deleted.version, 4);

      sa.send({ type: "comment", nodeId: d4, text: "Also good" });
      const node = await sb.next("node");
      assert.deepEqual([node.version, node.node.comment], [5, "Also good"]);

      sa.send({ type: "goto", nodeId: "root" });
      assert.deepEqual((await sb.next("cursor")).cursor, "root");

      sb.send({ type: "move", nodeId: "root", uci: "e2e5" });
      assert.equal((await sb.next("error")).data.code, "INVALID_STUDY_ACTION");

      // The owner removes Bob: he's told, his socket is closed (so he hears
      // no more of the room), and reconnecting is refused
      const closed = new Promise<number>((resolve) => sb.ws.once("close", (code) => resolve(code)));
      assert.equal((await request("DELETE", `/api/study/${roomId}/members/${bob.id}`, alice.clerkId)).statusCode, 204);
      await sb.next("removed");
      assert.equal(await closed, 4003);
      const again = await open(`/study/${roomId}`, bob.clerkId);
      assert.equal((await again.next("error")).data.code, "STUDY_NOT_FOUND");
      sa.send({ type: "goto", nodeId: d4 });
      await sa.next("cursor");
      assert.equal(sb.messages.filter((m) => m.type === "cursor").length, 1);

      const rooms = (await request("GET", "/api/study", alice.clerkId)).json().rooms;
      assert.equal(rooms[0].moveCount, 3);
      assert.equal(rooms[0].memberCount, 1);

      const saClosed = new Promise<number>((resolve) => sa.ws.once("close", (code) => resolve(code)));
      assert.equal((await request("DELETE", `/api/study/${roomId}`, alice.clerkId)).statusCode, 204);
      await sa.next("room_deleted");
      assert.equal(await saClosed, 4004);
    });

    test("a deleted account can't be invited back into a room", async () => {
      const roomId: number = (await request("POST", "/api/study", alice.clerkId, { name: "R" })).json().room.id;
      await befriend(alice.id, bob.id);
      // Deleted between the friendship check and the insert: the profile is anonymised
      await app.pg.query(`UPDATE users SET "clerkId" = NULL WHERE id = $1`, [bob.id]);
      const res = await request("POST", `/api/study/${roomId}/members`, alice.clerkId, { userId: bob.id });
      assert.equal(res.statusCode, 403);
    });
  });

  describe("friends", () => {
    test("the other user hears about requests and friendships at once", async () => {
      const na = await open("/notifications", alice.clerkId);
      const nb = await open("/notifications", bob.clerkId);
      const updated = (socket: TestSocket, event: string) =>
        socket.next("friends_updated", (m) => m.data.event === event);

      // Sent, then cancelled by the sender
      let sent = await request("POST", "/api/friend-requests", alice.clerkId, { receiverId: bob.id });
      assert.equal(sent.statusCode, 201);
      const received = await updated(nb, "request_received");
      assert.deepEqual(received.data.user, { id: alice.id, username: "alice", avatarUrl: null });
      let requestId: number = sent.json().data.id;
      assert.equal((await request("DELETE", `/api/friend-requests/${requestId}`, alice.clerkId)).statusCode, 200);
      assert.equal((await updated(nb, "request_cancelled")).data.user.id, alice.id);

      // Sent, then declined by the receiver
      sent = await request("POST", "/api/friend-requests", alice.clerkId, { receiverId: bob.id });
      requestId = sent.json().data.id;
      await updated(nb, "request_received");
      assert.equal((await request("POST", `/api/friend-requests/${requestId}/decline`, bob.clerkId)).statusCode, 200);
      assert.equal((await updated(na, "request_declined")).data.user.id, bob.id);

      // Sent and accepted
      sent = await request("POST", "/api/friend-requests", alice.clerkId, { receiverId: bob.id });
      requestId = sent.json().data.id;
      await updated(nb, "request_received");
      assert.equal((await request("POST", `/api/friend-requests/${requestId}/accept`, bob.clerkId)).statusCode, 200);
      assert.deepEqual((await updated(na, "request_accepted")).data.user, { id: bob.id, username: "bobby" });

      // Unfriended
      assert.equal((await request("DELETE", `/api/friends/${alice.id}`, bob.clerkId)).statusCode, 200);
      assert.equal((await updated(na, "removed")).data.user.id, bob.id);

      // The one acting isn't told about their own action
      await na.none("friends_updated");
      assert.equal(nb.messages.filter((m) => m.type === "friends_updated").length, 4);
    });
  });

  describe("endgame progress", () => {
    test("attempts, completion and the best result are kept", async () => {
      const post = (body: object) => request("POST", "/api/endgames/kq-vs-k/attempts", alice.clerkId, body);
      await post({ success: false, moves: 30 });
      assert.equal((await post({ success: true, moves: 12 })).json().progress.bestMoves, 12);
      const last = (await post({ success: true, moves: 15 })).json().progress;
      assert.equal(last.attempts, 3);
      assert.equal(last.bestMoves, 12);
      assert.ok(last.completedAt);
      assert.equal((await request("POST", "/api/endgames/Bad Id/attempts", alice.clerkId, { success: true, moves: 1 })).statusCode, 400);
      const all = (await request("GET", "/api/endgames/progress", alice.clerkId)).json().progress;
      assert.equal(all.length, 1);
      assert.deepEqual((await request("GET", "/api/endgames/progress", bob.clerkId)).json().progress, []);
    });

    test("one player can't record unlimited exercises", async () => {
      await app.pg.query(
        `INSERT INTO endgame_progress ("userId", "exerciseId") SELECT $1, 'ex-' || i FROM generate_series(1, 500) i`,
        [alice.id]
      );
      const post = (id: string) => request("POST", `/api/endgames/${id}/attempts`, alice.clerkId, { success: true, moves: 5 });
      assert.equal((await post("ex-new")).statusCode, 409);
      // Existing ones still count
      assert.equal((await post("ex-1")).json().progress.attempts, 1);
    });
  });
});
