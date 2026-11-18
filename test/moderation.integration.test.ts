import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import type { FastifyInstance } from "fastify";
import { connect, createUser, integrationEnabled, resetDb, startTestApp, type TestSocket } from "./helpers.js";
import { createGame } from "../src/services/gameService.js";
import { UserService } from "../src/services/userService.js";

const skip = !integrationEnabled && "TEST_POSTGRES_URL / TEST_REDIS_URL not set";

describe("blocking and reporting", { skip }, () => {
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
  const request = (method: "GET" | "POST" | "PUT" | "DELETE", url: string, clerkId: string, payload?: object) =>
    app.inject({
      method,
      url,
      headers: { authorization: `Bearer ${clerkId}` },
      ...(payload && { payload }),
    });
  const block = (blocker: { clerkId: string }, blocked: { id: number }) =>
    request("PUT", `/api/blocks/${blocked.id}`, blocker.clerkId);
  const count = async (table: string) =>
    (await app.pg.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`)).rows[0]!.n;
  const newGame = () =>
    app.pg.transact((tx) => createGame(tx, { whiteId: alice.id, blackId: bob.id, time: 180, increment: 0 }));

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

  describe("blocks", () => {
    test("block, list and unblock; all three can be repeated", async () => {
      assert.equal((await block(alice, bob)).statusCode, 204);
      assert.equal((await block(alice, bob)).statusCode, 204);
      const listed = (await request("GET", "/api/blocks", alice.clerkId)).json();
      assert.deepEqual(
        listed.data.map((u: any) => [u.id, u.username]),
        [[bob.id, "bobby"]]
      );
      // The list is the blocker's own: Bob's is empty
      assert.deepEqual((await request("GET", "/api/blocks", bob.clerkId)).json().data, []);

      assert.equal((await request("DELETE", `/api/blocks/${bob.id}`, alice.clerkId)).statusCode, 204);
      assert.equal((await request("DELETE", `/api/blocks/${bob.id}`, alice.clerkId)).statusCode, 204);
      assert.deepEqual((await request("GET", "/api/blocks", alice.clerkId)).json().data, []);
    });

    test("refuses yourself, unknown players, deleted accounts and anonymous requests", async () => {
      assert.equal((await block(alice, alice)).statusCode, 400);
      assert.equal((await request("PUT", "/api/blocks/999999", alice.clerkId)).statusCode, 404);
      assert.equal((await request("PUT", "/api/blocks/abc", alice.clerkId)).statusCode, 400);
      assert.equal((await app.inject({ method: "PUT", url: `/api/blocks/${bob.id}` })).statusCode, 401);
      assert.equal((await app.inject({ method: "GET", url: "/api/blocks" })).statusCode, 401);

      const carol = await createUser(app, "carol");
      await new UserService(app).deleteAccount(carol.clerkId);
      assert.equal((await block(alice, carol)).statusCode, 404);
      assert.equal(await count("user_blocks"), 0);
    });

    test("blocking ends the friendship and withdraws requests and challenges, quietly", async () => {
      const carol = await createUser(app, "carol");
      await app.pg.query(`INSERT INTO friends ("userOneId", "userTwoId") VALUES ($1, $2)`, [alice.id, bob.id]);
      const na = await open("/notifications", alice.clerkId);
      const nb = await open("/notifications", bob.clerkId);
      const nc = await open("/notifications", carol.clerkId);
      // Bob challenged Alice; Carol asked to be Alice's friend
      nb.send({ type: "challenge_sent", data: { challengedId: alice.id, color: "white", time: 180, increment: 0 } });
      await na.next("challenge_received");
      assert.equal(
        (await request("POST", "/api/friend-requests", carol.clerkId, { receiverId: alice.id })).statusCode,
        201
      );

      await block(alice, bob);
      assert.equal(await count("friends"), 0);
      assert.equal(await count("challenges"), 0);
      // Bob sees an unfriending and a challenge that lapsed, not a block
      const removed = await nb.next("friends_updated");
      assert.deepEqual(removed.data, { event: "removed", user: { id: alice.id } });
      const lapsed = await nb.next("challenge_declined");
      assert.deepEqual(lapsed.data, { challengedId: alice.id, reason: "expired" });
      await na.next("challenge_cancelled");
      await na.next("blocks_updated");

      await block(alice, carol);
      assert.equal(await count("friend_requests"), 0);
      assert.equal((await nc.next("friends_updated")).data.event, "request_declined");
    });

    for (const direction of ["the blocker", "the blocked player"] as const) {
      test(`${direction} can't challenge or befriend the other`, async () => {
        await block(alice, bob);
        const [from, to] = direction === "the blocker" ? [alice, bob] : [bob, alice];
        const nFrom = await open("/notifications", from.clerkId);
        const nTo = await open("/notifications", to.clerkId);
        nFrom.send({ type: "challenge_sent", data: { challengedId: to.id, color: "white", time: 180, increment: 0 } });
        const error = await nFrom.next("error");
        // The blocked player is told what a "nobody" setting would say
        assert.equal(error.data.code, direction === "the blocker" ? "BLOCKED_BY_YOU" : "CHALLENGES_OFF");
        await nTo.none("challenge_received");
        assert.equal(await count("challenges"), 0);

        const friendRequest = await request("POST", "/api/friend-requests", from.clerkId, { receiverId: to.id });
        if (direction === "the blocker") {
          assert.equal(friendRequest.statusCode, 403);
          assert.equal(friendRequest.json().code, "BLOCKED_BY_YOU");
        } else {
          // Exactly what a cooldown after a cancel or decline says: there is
          // no "friend requests off" setting, so anything else would only
          // ever mean a block
          const carol = await createUser(app, "carol");
          const sent = await request("POST", "/api/friend-requests", from.clerkId, { receiverId: carol.id });
          await request("DELETE", `/api/friend-requests/${sent.json().data.id}`, from.clerkId);
          const cooldown = await request("POST", "/api/friend-requests", from.clerkId, { receiverId: carol.id });
          assert.equal(friendRequest.statusCode, cooldown.statusCode);
          assert.deepEqual(friendRequest.json(), cooldown.json());
          assert.equal(friendRequest.json().code, "FRIEND_REQUEST_COOLDOWN");
        }
        assert.equal(await count("friend_requests"), 0);
      });
    }

    test("blocked players don't appear in each other's suggestions; search hides only who you blocked", async () => {
      await block(alice, bob);
      for (const [viewer, other] of [[alice, "bobby"], [bob, "alice"]] as const) {
        const suggested = (await request("GET", "/api/friends/suggestions", viewer.clerkId)).json();
        assert.equal(suggested.data.some((u: any) => u.username === other), false);
      }
      // Alice doesn't find the player she blocked
      assert.deepEqual((await request("GET", "/api/friends/suggestions?q=bobby", alice.clerkId)).json().data, []);
      // Bob finds Alice like anyone else: an empty search would tell him he
      // was blocked (he can see her profile and their old games anyway)
      const found = (await request("GET", "/api/friends/suggestions?q=alice", bob.clerkId)).json();
      assert.deepEqual(found.data.map((u: any) => u.username), ["alice"]);

      await request("DELETE", `/api/blocks/${bob.id}`, alice.clerkId);
      const unblocked = (await request("GET", "/api/friends/suggestions?q=bobby", alice.clerkId)).json();
      assert.equal(unblocked.data.length, 1);
    });

    test("matchmaking never pairs the two", async () => {
      await block(alice, bob);
      await Promise.all([
        open("/matchmaking?time=180&increment=0", alice.clerkId),
        open("/matchmaking?time=180&increment=0", bob.clerkId),
      ]);
      // Both are queued a moment after their sockets open
      await new Promise((r) => setTimeout(r, 200));
      await app.matchmaking.sweep();
      await app.matchmaking.sweep();
      assert.equal(await count("games"), 0);
      assert.equal(await count("matchmaking"), 2);

      // Someone else is paired with whoever has waited longest
      const carol = await createUser(app, "carol");
      await open("/matchmaking?time=180&increment=0", carol.clerkId);
      await new Promise((r) => setTimeout(r, 200));
      await app.matchmaking.sweep();
      const { rows } = await app.pg.query(`SELECT "whiteId", "blackId" FROM games`);
      assert.equal(rows.length, 1);
      assert.equal([rows[0].whiteId, rows[0].blackId].includes(carol.id), true);
    });

    test("a block during a game closes its chat for both and rules out a rematch", async () => {
      const game = await newGame();
      const ga = await open(`/game/${game.id}`, alice.clerkId);
      const gb = await open(`/game/${game.id}`, bob.clerkId);
      assert.equal((await ga.next("initial_game_state")).data.chat.enabled, true);
      await gb.next("initial_game_state");
      gb.send({ type: "chat", text: "you are bad" });
      await ga.next("chat");

      await block(alice, bob);
      // Alice knows why; Bob is told only that his opponent has chat off
      assert.deepEqual((await ga.next("chat_status")).data, { enabled: false, reason: "blocked", messages: [] });
      assert.deepEqual((await gb.next("chat_status")).data, {
        enabled: false,
        reason: "off_by_opponent",
        messages: [],
      });
      gb.send({ type: "chat", text: "hello?" });
      assert.equal((await gb.next("error")).data.code, "CHAT_DISABLED");
      await ga.none("chat");
      assert.equal(await count("game_chat_messages"), 1);

      // Unblocking opens the chat again, with what was written before
      await request("DELETE", `/api/blocks/${bob.id}`, alice.clerkId);
      const reopened = await gb.next("chat_status");
      assert.deepEqual([reopened.data.enabled, reopened.data.messages.length], [true, 1]);
      await ga.next("chat_status");

      await block(alice, bob);
      await gb.next("chat_status");
      ga.send({ type: "resign" });
      await gb.next("game_ended");
      gb.send({ type: "rematch_request" });
      assert.equal((await gb.next("error", (m) => m.data.code !== "CHAT_DISABLED")).data.code, "REMATCH_UNAVAILABLE");
      await ga.none("rematch_request");
    });

    test("deleting an account removes its blocks, in both directions", async () => {
      const carol = await createUser(app, "carol");
      await block(alice, bob);
      await block(carol, alice);
      await new UserService(app).deleteAccount(alice.clerkId);
      assert.equal(await count("user_blocks"), 0);
    });
  });

  describe("reports", () => {
    const report = (reporter: { clerkId: string }, payload: object) =>
      request("POST", "/api/reports", reporter.clerkId, payload);
    const reports = async () => (await app.pg.query(`SELECT * FROM user_reports ORDER BY id`)).rows;

    test("stores who, why and the details, trimmed", async () => {
      const response = await report(alice, { reportedId: bob.id, reason: "cheating", details: "  engine moves  " });
      assert.equal(response.statusCode, 201);
      const [row] = await reports();
      assert.deepEqual(
        [row.id, row.reporterId, row.reportedId, row.reason, row.details, row.gameId, row.chatExcerpt, row.status],
        [response.json().data.id, alice.id, bob.id, "cheating", "engine moves", null, null, "open"]
      );
    });

    test("details are stored without control or invisible characters", async () => {
      const details = "\u001b[2J\u001b[1;31mFAKE: report closed\u001b[0m\r\nengine\u202e moves\u200b\n\n\n\nreally";
      assert.equal((await report(alice, { reportedId: bob.id, reason: "cheating", details })).statusCode, 201);
      const [row] = await reports();
      assert.equal(row.details, "[2J[1;31mFAKE: report closed[0m\nengine moves\n\nreally");
      // Nothing visible left: no details
      await report(alice, { reportedId: (await createUser(app, "carol")).id, reason: "other", details: "\u0007\u200b " });
      assert.equal((await reports())[1].details, null);
    });

    test("a report from a game keeps that game's chat", async () => {
      const game = await newGame();
      const ga = await open(`/game/${game.id}`, alice.clerkId);
      const gb = await open(`/game/${game.id}`, bob.clerkId);
      await ga.next("initial_game_state");
      await gb.next("initial_game_state");
      gb.send({ type: "chat", text: "you are bad" });
      await ga.next("chat");
      ga.send({ type: "chat", text: "be nice" });
      await gb.next("chat");

      const response = await report(alice, { reportedId: bob.id, reason: "abusive_chat", gameId: game.id });
      assert.equal(response.statusCode, 201);
      const [row] = await reports();
      assert.equal(row.gameId, game.id);
      assert.deepEqual(
        row.chatExcerpt.map((m: any) => [m.userId, m.text]),
        [[bob.id, "you are bad"], [alice.id, "be nice"]]
      );
    });

    test("refuses a game the two didn't play, bad input, yourself and unknown players", async () => {
      const carol = await createUser(app, "carol");
      const game = await newGame();
      const refused = [
        [carol, { reportedId: bob.id, reason: "cheating", gameId: game.id }, 400],
        [alice, { reportedId: carol.id, reason: "cheating", gameId: game.id }, 400],
        [alice, { reportedId: bob.id, reason: "cheating", gameId: 999999 }, 400],
        [alice, { reportedId: bob.id, reason: "being annoying" }, 400],
        [alice, { reportedId: bob.id }, 400],
        [alice, { reportedId: bob.id, reason: "other", details: "x".repeat(1001) }, 400],
        [alice, { reportedId: alice.id, reason: "other" }, 400],
        [alice, { reportedId: 999999, reason: "other" }, 404],
      ] as const;
      for (const [reporter, payload, status] of refused) {
        assert.equal((await report(reporter, payload)).statusCode, status, JSON.stringify(payload));
      }
      assert.equal(
        (await app.inject({ method: "POST", url: "/api/reports", payload: { reportedId: bob.id, reason: "other" } }))
          .statusCode,
        401
      );
      assert.equal(await count("user_reports"), 0);
    });

    test("the same player can't be reported twice in a day by one account", async () => {
      const carol = await createUser(app, "carol");
      assert.equal((await report(alice, { reportedId: bob.id, reason: "cheating" })).statusCode, 201);
      const again = await report(alice, { reportedId: bob.id, reason: "unsporting" });
      assert.equal(again.statusCode, 409);
      assert.equal(again.json().code, "ALREADY_REPORTED");
      // Someone else can, and Alice can report someone else
      assert.equal((await report(carol, { reportedId: bob.id, reason: "cheating" })).statusCode, 201);
      assert.equal((await report(alice, { reportedId: carol.id, reason: "offensive_name" })).statusCode, 201);
      assert.equal(await count("user_reports"), 3);

      // A day later the first report no longer stands in the way
      await app.pg.query(`UPDATE user_reports SET "createdAt" = now() - interval '25 hours' WHERE "reporterId" = $1`, [
        alice.id,
      ]);
      assert.equal((await report(alice, { reportedId: bob.id, reason: "cheating" })).statusCode, 201);
    });

    test("one account can file only so many reports a day", async () => {
      // Through the service: the route's own per-minute limit would cut in first
      const targets = [];
      for (let i = 0; i < 21; i++) targets.push(await createUser(app, `target${i}`));
      for (const target of targets.slice(0, 20)) {
        await app.moderation.report(alice.id, { reportedId: target.id, reason: "other" });
      }
      await assert.rejects(
        app.moderation.report(alice.id, { reportedId: targets[20]!.id, reason: "other" }),
        (error: any) => error.code === "REPORT_RATE_LIMITED" && error.statusCode === 429
      );
      assert.equal(await count("user_reports"), 20);
    });
  });
});
