import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import type { FastifyInstance } from "fastify";
import { connect, createUser, integrationEnabled, resetDb, startTestApp, type TestSocket } from "./helpers.js";
import { STUDY_WRITE_LIMIT } from "../src/services/studyService.js";
import { AppError } from "../src/errors/AppError.js";

const skip = !integrationEnabled && "TEST_POSTGRES_URL / TEST_REDIS_URL not set";

describe("study rooms: cursor, versions and limits", { skip }, () => {
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
  const request = (method: "GET" | "POST" | "DELETE", url: string, clerkId: string, payload?: object) =>
    app.inject({ method, url, headers: { authorization: `Bearer ${clerkId}` }, ...(payload && { payload }) });

  /** A room of Alice's with Bob in it, started from 1.e4 e5. */
  const newRoom = async () => {
    const roomId: number = (
      await request("POST", "/api/study", alice.clerkId, { name: "Review", moves: ["e4", "e5"] })
    ).json().room.id;
    await app.pg.query(`INSERT INTO friends ("userOneId", "userTwoId") VALUES ($1, $2)`, [alice.id, bob.id]);
    await request("POST", `/api/study/${roomId}/members`, alice.clerkId, { userId: bob.id });
    const { state } = (await request("GET", `/api/study/${roomId}`, alice.clerkId)).json();
    const e4: string = state.nodes.root.children[0];
    const e5: string = state.nodes[e4].children[0];
    return { roomId, e4, e5 };
  };
  const row = async (roomId: number) =>
    (
      await app.pg.query(
        `SELECT cursor, version, "nodeCount", state->>'cursor' AS "storedCursor" FROM study_rooms WHERE id = $1`,
        [roomId]
      )
    ).rows[0];
  const codeOf = (promise: Promise<unknown>) =>
    promise.then(
      () => null,
      (error) => (error instanceof AppError ? error.code : String(error))
    );

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

  test("moving around the tree only changes the cursor, and versions stay one sequence", async () => {
    const { roomId, e4, e5 } = await newRoom();
    const sa = await open(`/study/${roomId}`, alice.clerkId);
    const sb = await open(`/study/${roomId}`, bob.clerkId);
    assert.equal((await sb.next("study_state")).state.cursor, "root");
    await sa.next("study_state");
    // A marker in the stored document: any rewrite of it would drop it
    // (the cursor lives in its own column and isn't written into it)
    await app.pg.query(`UPDATE study_rooms SET state = state || '{"cursor": "marker"}' WHERE id = $1`, [roomId]);

    sa.send({ type: "goto", nodeId: e5 });
    assert.deepEqual(await sb.next("cursor"), { type: "cursor", cursor: e5, version: 1, by: alice.id });
    // Replaying a move the tree has goes to it, the same way
    sa.send({ type: "goto", nodeId: "root" });
    assert.equal((await sb.next("cursor")).version, 2);
    sb.send({ type: "move", nodeId: "root", uci: "e2e4" });
    assert.deepEqual(await sa.next("cursor", (m) => m.version === 3), { type: "cursor", cursor: e4, version: 3, by: bob.id });
    assert.deepEqual(await row(roomId), { cursor: e4, version: 3, nodeCount: 3, storedCursor: "marker" });

    // Already there: nothing changes and nothing is sent
    sa.send({ type: "goto", nodeId: e4 });
    // A position that isn't in the tree
    sa.send({ type: "goto", nodeId: "n99" });
    assert.equal((await sa.next("error")).data.code, "INVALID_STUDY_ACTION");
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(sb.messages.filter((m) => m.type === "cursor").length, 3);
    assert.equal((await row(roomId)).version, 3);

    // Changes to the tree rewrite the document (without the cursor) and continue the sequence
    sb.send({ type: "comment", nodeId: e4, text: "King's pawn" });
    assert.equal((await sa.next("node")).version, 4);
    sb.send({ type: "move", nodeId: "root", uci: "d2d4" });
    const added = await sa.next("node_added");
    assert.equal(added.version, 5);
    assert.deepEqual(await row(roomId), { cursor: added.cursor, version: 5, nodeCount: 4, storedCursor: null });
    sa.send({ type: "goto", nodeId: e4 });
    assert.equal((await sb.next("cursor", (m) => m.version === 6)).cursor, e4);

    // The whole room still comes as one document, cursor included
    sb.send({ type: "sync" });
    const synced = await sb.next("study_state", (m) => m.room.version === 6);
    assert.equal(synced.state.cursor, e4);
    assert.equal(synced.state.nodes[e4].comment, "King's pawn");
    const rooms = (await request("GET", "/api/study", alice.clerkId)).json().rooms;
    assert.equal(rooms[0].moveCount, 3);
  });

  test("concurrent changes from both paths get one version each", async () => {
    const { roomId, e4, e5 } = await newRoom();
    const listener = await open(`/study/${roomId}`, alice.clerkId);
    await listener.next("study_state");
    const ops = [
      app.study.apply(roomId, alice.id, { type: "goto", nodeId: e5 }),
      app.study.apply(roomId, bob.id, { type: "move", nodeId: "root", uci: "d2d4" }),
      app.study.apply(roomId, alice.id, { type: "move", nodeId: "root", uci: "e2e4" }),
      app.study.apply(roomId, bob.id, { type: "comment", nodeId: e4, text: "x" }),
      app.study.apply(roomId, alice.id, { type: "goto", nodeId: "root" }),
      app.study.apply(roomId, bob.id, { type: "shapes", nodeId: e5, shapes: [{ orig: "e7", dest: "e5", brush: "red" }] }),
    ];
    await Promise.all(ops);
    const { version } = await row(roomId);
    // A goto onto where the cursor already is changes nothing, so some may not count
    assert.ok(version >= 4 && version <= 6, `version ${version}`);
    await new Promise((r) => setTimeout(r, 200));
    const versions = listener.messages.filter((m) => typeof m.version === "number").map((m) => m.version);
    assert.deepEqual(
      [...versions].sort((a, b) => a - b),
      Array.from({ length: version }, (_, i) => i + 1)
    );
  });

  test("someone removed from the room can't move its cursor", async () => {
    const { roomId, e4 } = await newRoom();
    assert.equal((await request("DELETE", `/api/study/${roomId}/members/${bob.id}`, alice.clerkId)).statusCode, 204);
    assert.equal(await codeOf(app.study.apply(roomId, bob.id, { type: "goto", nodeId: e4 })), "STUDY_NOT_FOUND");
    assert.equal(
      await codeOf(app.study.apply(roomId, bob.id, { type: "move", nodeId: "root", uci: "e2e4" })),
      "STUDY_NOT_FOUND"
    );
    assert.equal(await codeOf(app.study.apply(9999, alice.id, { type: "goto", nodeId: e4 })), "STUDY_NOT_FOUND");
    assert.equal((await row(roomId)).version, 0);
  });

  test("moving around isn't limited over all sockets, only by each socket's own limit", async () => {
    const { roomId, e4, e5 } = await newRoom();
    const first = await open(`/study/${roomId}`, alice.clerkId);
    const second = await open(`/study/${roomId}`, alice.clerkId);
    await first.next("study_state");
    await second.next("study_state");
    // Like an arrow key held down in two tabs: each socket stays under its
    // own limit (a burst of 20), and together they make more cursor moves in
    // a moment than any shared limit used to allow
    const perSocket = 18;
    for (let i = 0; i < perSocket; i++) {
      first.send({ type: "goto", nodeId: i % 2 ? e4 : e5 });
      second.send(i % 2 ? { type: "goto", nodeId: "root" } : { type: "move", nodeId: "root", uci: "e2e4" });
    }
    await new Promise((r) => setTimeout(r, 500));
    const errors = [...first.messages, ...second.messages].filter((m) => m.type === "error");
    assert.deepEqual(errors, []);
    assert.equal((await row(roomId)).nodeCount, 3); // replaying e4 added nothing
    // and none of it was counted against the limit on rewrites
    for (let i = 0; i < STUDY_WRITE_LIMIT.max; i++) {
      await app.study.apply(roomId, alice.id, { type: "comment", nodeId: e4, text: `note ${i}` });
    }
  });

  test("changes that rewrite the document have a smaller limit", async () => {
    const { roomId, e4 } = await newRoom();
    for (let i = 0; i < STUDY_WRITE_LIMIT.max; i++) {
      await app.study.apply(roomId, bob.id, { type: "comment", nodeId: e4, text: `note ${i}` });
    }
    assert.equal(
      await codeOf(app.study.apply(roomId, bob.id, { type: "comment", nodeId: e4, text: "one more" })),
      "RATE_LIMITED"
    );
    // Moving around is still allowed
    assert.equal(await codeOf(app.study.apply(roomId, bob.id, { type: "goto", nodeId: e4 })), null);
    assert.equal((await row(roomId)).version, STUDY_WRITE_LIMIT.max + 1);
  });

  test("a cursor column that names a deleted node falls back, and nodeCount heals on the next write", async () => {
    const { roomId, e4, e5 } = await newRoom();
    // What code from before migration 031 leaves behind: it deleted the
    // node the column points at and wrote its own cursor into the document
    // only; the count is stale too
    await app.pg.query(
      `UPDATE study_rooms SET cursor = 'gone', "nodeCount" = 99, state = state || jsonb_build_object('cursor', $2::text)
       WHERE id = $1`,
      [roomId, e4]
    );
    assert.equal((await request("GET", `/api/study/${roomId}`, bob.clerkId)).json().state.cursor, e4);
    // Without a usable cursor in the document either: the root
    await app.pg.query(`UPDATE study_rooms SET state = state || '{"cursor": "gone"}' WHERE id = $1`, [roomId]);
    assert.equal((await request("GET", `/api/study/${roomId}`, bob.clerkId)).json().state.cursor, "root");
    const sb = await open(`/study/${roomId}`, bob.clerkId);
    assert.equal((await sb.next("study_state")).state.cursor, "root");

    // A rewrite works from the root and stores a valid cursor and the right count
    await app.study.apply(roomId, bob.id, { type: "comment", nodeId: e5, text: "fine" });
    assert.deepEqual(await row(roomId), { cursor: "root", version: 1, nodeCount: 3, storedCursor: null });
    // A delete computes its new cursor from the one in use: deleting the
    // node old code left the group on moves it to the parent
    await app.pg.query(
      `UPDATE study_rooms SET cursor = 'gone', state = state || jsonb_build_object('cursor', $2::text) WHERE id = $1`,
      [roomId, e5]
    );
    await app.study.apply(roomId, bob.id, { type: "delete", nodeId: e5 });
    assert.deepEqual(await row(roomId), { cursor: e4, version: 2, nodeCount: 2, storedCursor: null });
  });
});
