import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import type { FastifyInstance } from "fastify";
import { Chess } from "chess.js";
import { connect, createUser, integrationEnabled, resetDb, startTestApp, type TestSocket } from "./helpers.js";
import { MAX_PENDING_TABLE_GAMES_PER_PAIR, TABLE_GAMES_PER_DAY } from "../src/game/tableGame.js";

const skip = !integrationEnabled && "TEST_POSTGRES_URL / TEST_REDIS_URL not set";
type User = { id: number; clerkId: string };

const pgnOf = (...sans: string[]) => {
  const chess = new Chess();
  for (const san of sans) chess.move(san);
  return chess.pgn();
};
const FOOLS_MATE = pgnOf("f3", "e5", "g4", "Qh4#");

describe("table mode: games at a real board", { skip }, () => {
  let app: FastifyInstance;
  let baseUrl: string;
  let ann: User;
  let ben: User;
  const sockets: TestSocket[] = [];

  const open = async (path: string, user: User) => {
    const socket = await connect(baseUrl, path, user.clerkId);
    sockets.push(socket);
    return socket;
  };
  const request = (method: "GET" | "POST" | "DELETE", url: string, user: User, payload?: object) =>
    app.inject({ method, url, headers: { authorization: `Bearer ${user.clerkId}` }, ...(payload && { payload }) });
  const befriend = (a: User, b: User) =>
    app.pg.query(`INSERT INTO friends ("userOneId", "userTwoId") VALUES ($1, $2)`, [a.id, b.id]);
  /** Ann recorded a game where she was black and won by mate */
  const body = (opponent: object, overrides: object = {}) => ({
    pgn: FOOLS_MATE,
    result: "black_win",
    endReason: "checkmate",
    color: "black",
    whiteTime: 300,
    blackTime: 300,
    increment: 3,
    opponent,
    ...overrides,
  });
  const save = (user: User, opponent: object, overrides: object = {}) =>
    request("POST", "/api/games/table", user, body(opponent, overrides));
  const history = async (user: User) =>
    (await request("GET", `/api/users/${user.id}/games`, user)).json();
  const listed = async (user: User) =>
    (await app.pg.query(`SELECT "listedGames" FROM users WHERE id = $1`, [user.id])).rows[0].listedGames;

  before(async () => {
    ({ app, baseUrl } = await startTestApp());
  });
  after(async () => {
    await app.close();
  });
  beforeEach(async () => {
    await Promise.all(sockets.splice(0).map((s) => s.close()));
    await resetDb(app);
    ann = await createUser(app, "annie");
    ben = await createUser(app, "benny");
  });

  test("a game with a guest is stored unrated, shows in history and review, and touches no rating", async () => {
    const before = (await app.pg.query(`SELECT "blitzRating", "blitzGames" FROM users WHERE id = $1`, [ann.id])).rows[0];
    const saved = await save(ann, { kind: "guest", name: "  Uncle​ Bob " });
    assert.equal(saved.statusCode, 201, saved.body);
    const game = saved.json();
    assert.equal(game.tableGame, true);
    assert.equal(game.rated, false);
    assert.equal(game.status, "finished");
    assert.equal(game.result, "black_win");
    assert.equal(game.endReason, "checkmate");
    assert.equal(game.winnerId, ann.id);
    assert.deepEqual([game.whitePlayer.id, game.whitePlayer.username], [null, "Uncle Bob"]);
    assert.equal(game.blackPlayer.id, ann.id);
    assert.deepEqual([game.time, game.increment, game.whiteTime], [300, 3, null]);

    const page = await history(ann);
    assert.equal(page.data?.length ?? page.games?.length, 1);
    assert.equal(await listed(ann), 1);
    assert.equal((await request("GET", `/api/games/${game.id}`, ann)).json().pgn.includes("Qh4#"), true);

    // No rating, rating-game count or stats moved
    const after = (await app.pg.query(`SELECT "blitzRating", "blitzGames" FROM users WHERE id = $1`, [ann.id])).rows[0];
    assert.deepEqual(after, before);

    // Not a live game: no socket actions, chat, rematch or share link
    assert.equal((await request("GET", "/api/games/active", ann)).json().gameId, null);
    const s = await open(`/game/${game.id}`, ann);
    assert.equal((await s.next("error")).type, "error");
    assert.equal((await request("POST", `/api/games/${game.id}/share`, ann)).statusCode, 409);
  });

  test("time odds are kept; guest names are checked", async () => {
    const odds = (await save(ann, { kind: "guest", name: "Kid" }, { whiteTime: 600, blackTime: 120 })).json();
    assert.deepEqual([odds.time, odds.whiteTime, odds.blackTime], [600, 600, 120]);
    assert.equal((await save(ann, { kind: "guest", name: "​  " })).statusCode, 400);
    assert.equal((await save(ann, { kind: "guest", name: "x".repeat(31) })).statusCode, 400);
  });

  test("the server replays the game and checks the result", async () => {
    // A mate claimed as something else
    const wrong = await save(ann, { kind: "guest", name: "G" }, { result: "white_win", endReason: "resignation" });
    assert.equal(wrong.statusCode, 400);
    assert.match(wrong.body, /INVALID_TABLE_GAME/);
    // A flag falls for the side to move, as the server rules it
    const flag = await save(ann, { kind: "guest", name: "G" }, { pgn: pgnOf("e4", "e5"), result: "black_win", endReason: "timeout" });
    assert.equal(flag.statusCode, 201, flag.body);
    assert.equal(
      (await save(ann, { kind: "guest", name: "G" }, { pgn: pgnOf("e4", "e5"), result: "white_win", endReason: "timeout" })).statusCode,
      400
    );
    assert.equal((await save(ann, { kind: "guest", name: "G" }, { pgn: "1. e5" })).statusCode, 400);
    // Length cap
    assert.equal((await save(ann, { kind: "guest", name: "G" }, { pgn: "1. e4 ".repeat(2_000) })).statusCode, 400);
  });

  test("a daily limit, like bot games", async () => {
    await app.redis.set(`tablegames:saved:${ann.id}`, String(TABLE_GAMES_PER_DAY));
    await app.redis.expire(`tablegames:saved:${ann.id}`, 60);
    const limited = await save(ann, { kind: "guest", name: "G" });
    assert.equal(limited.statusCode, 429);
    assert.match(limited.body, /TABLE_GAME_LIMIT/);
  });

  test("a friend confirms in their inbox; only then is it in their history", async () => {
    // Only friends can be named
    const stranger = await save(ann, { kind: "friend", userId: ben.id });
    assert.equal(stranger.statusCode, 403);
    assert.match(stranger.body, /NOT_FRIENDS/);
    await befriend(ann, ben);

    const notes = await open("/notifications", ben);
    const game = (await save(ann, { kind: "friend", userId: ben.id })).json();
    // Not linked to Ben yet: his name only
    assert.deepEqual([game.whitePlayer.id, game.whitePlayer.username], [null, "benny"]);
    const note = await notes.next("table_game_request");
    assert.equal(note.data.gameId, game.id);
    assert.equal(note.data.color, "white");
    assert.equal(note.data.from.id, ann.id);
    const inbox = (await request("GET", "/api/games/table/requests", ben)).json().requests;
    assert.deepEqual(inbox.map((r: { gameId: number }) => r.gameId), [game.id]);
    assert.equal((await history(ben)).total ?? (await history(ben)).pagination?.total, 0);
    assert.equal(await listed(ben), 0);

    // Only Ben can answer
    assert.equal((await request("POST", `/api/games/table/requests/${game.id}/confirm`, ann)).statusCode, 404);
    assert.equal((await request("POST", `/api/games/table/requests/${game.id}/confirm`, ben)).statusCode, 204);
    assert.equal((await notes.next("table_game_answered")).data.confirmed, true);
    const confirmed = (await request("GET", `/api/games/${game.id}`, ben)).json();
    assert.equal(confirmed.whitePlayer.id, ben.id);
    assert.equal(confirmed.winnerId, ann.id);
    assert.equal(await listed(ben), 1);
    assert.deepEqual((await request("GET", "/api/games/table/requests", ben)).json().requests, []);
    // Once only
    assert.equal((await request("POST", `/api/games/table/requests/${game.id}/confirm`, ben)).statusCode, 404);

    // Still not head-to-head, chat, a report or a rated game between them
    const h2h = (await request("GET", `/api/users/${ann.id}/head-to-head`, ben)).json();
    assert.deepEqual([h2h.wins, h2h.draws, h2h.losses], [0, 0, 0]);
    assert.equal(
      (await request("POST", "/api/reports", ben, { reportedId: ann.id, reason: "unsporting", gameId: game.id })).statusCode,
      400
    );
    assert.equal(await app.gameChat.state(game.id, ben.id), null);
  });

  test("a friend's win is theirs once they confirm, and they can decline", async () => {
    await befriend(ann, ben);
    // Ann (white) resigned: Ben won
    const lost = (await save(ann, { kind: "friend", userId: ben.id }, { color: "white", pgn: pgnOf("e4"), result: "black_win", endReason: "resignation" })).json();
    assert.equal(lost.winnerId, null);
    await request("POST", `/api/games/table/requests/${lost.id}/confirm`, ben);
    assert.equal((await request("GET", `/api/games/${lost.id}`, ben)).json().winnerId, ben.id);

    const declined = (await save(ann, { kind: "friend", userId: ben.id })).json();
    assert.equal((await request("POST", `/api/games/table/requests/${declined.id}/decline`, ben)).statusCode, 204);
    assert.deepEqual((await request("GET", "/api/games/table/requests", ben)).json().requests, []);
    // Ann keeps it, with Ben's name only
    const kept = (await request("GET", `/api/games/${declined.id}`, ann)).json();
    assert.deepEqual([kept.whitePlayer.id, kept.whitePlayer.username], [null, "benny"]);
    assert.equal((await request("POST", `/api/games/table/requests/${declined.id}/confirm`, ben)).statusCode, 404);
  });

  test("pending requests per pair are limited, and a block withdraws them", async () => {
    await befriend(ann, ben);
    const ids: number[] = [];
    for (let i = 0; i < MAX_PENDING_TABLE_GAMES_PER_PAIR; i++) {
      ids.push((await save(ann, { kind: "friend", userId: ben.id })).json().id);
    }
    const over = await save(ann, { kind: "friend", userId: ben.id });
    assert.equal(over.statusCode, 409);
    assert.match(over.body, /TOO_MANY_PENDING/);
    // Answering one frees a place
    await request("POST", `/api/games/table/requests/${ids[0]}/decline`, ben);
    assert.equal((await save(ann, { kind: "friend", userId: ben.id })).statusCode, 201);

    // Ben blocks Ann: her requests go, and she can't name him any more
    const blocked = await app.inject({ method: "PUT", url: `/api/blocks/${ann.id}`, headers: { authorization: `Bearer ${ben.clerkId}` } });
    assert.equal(blocked.statusCode < 300, true, blocked.body);
    assert.deepEqual((await request("GET", "/api/games/table/requests", ben)).json().requests, []);
    assert.equal((await request("POST", `/api/games/table/requests/${ids[1]}/confirm`, ben)).statusCode, 404);
    assert.equal((await save(ann, { kind: "friend", userId: ben.id })).statusCode, 403);
  });

  test("left out of drills and the repertoire check", async () => {
    // Ann lost a long table game: a drill candidate if it were an online game
    const sans = ["e4", "e5", "Nf3", "Nc6", "Bc4", "Bc5", "c3", "Nf6", "d4", "exd4", "cxd4", "Bb4+", "Nc3", "Nxe4", "O-O", "Bxc3", "d5", "Bf6", "Re1", "Ne7", "Rxe4", "d6", "Bg5", "Bxg5", "Nxg5", "h6"];
    const saved = await save(ann, { kind: "guest", name: "Club" }, { color: "white", pgn: pgnOf(...sans), result: "black_win", endReason: "resignation" });
    assert.equal(saved.statusCode, 201, saved.body);
    const candidates = (await request("GET", "/api/conversion-drills/candidates", ann)).json();
    assert.equal(JSON.stringify(candidates).includes(`"gameId":${saved.json().id}`), false);
    const check = (await request("GET", "/api/repertoire/check", ann)).json();
    assert.equal(JSON.stringify(check).includes(`"gameId":${saved.json().id}`) || JSON.stringify(check).includes(`"id":${saved.json().id}`), false);
  });

  test("deleting the account of a friend who never confirmed takes their name off", async () => {
    await befriend(ann, ben);
    const game = (await save(ann, { kind: "friend", userId: ben.id })).json();
    assert.equal((await request("DELETE", "/api/users/me", ben)).statusCode, 204);
    const after = (await request("GET", `/api/games/${game.id}`, ann)).json();
    assert.equal(after.whitePlayer.username, `deleted-${ben.id}`);
    assert.equal((await app.pg.query(`SELECT 1 FROM table_game_requests`)).rows.length, 0);
  });
});
