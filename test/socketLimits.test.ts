import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { FastifyBaseLogger } from "fastify";
import type { WebSocket } from "ws";
import { keepAuthenticated, limitedSync, MAX_BUFFERED_BYTES, sendJson, sendText } from "../src/realtime/socket.js";

/** As much of a ws socket as the senders and limiters use */
class FakeSocket extends EventEmitter {
  readonly OPEN = 1;
  readyState = 1;
  bufferedAmount = 0;
  sent: string[] = [];
  terminated = false;
  send(payload: string) {
    this.sent.push(payload);
  }
  terminate() {
    this.terminated = true;
    this.readyState = 3;
  }
  close() {
    this.readyState = 3;
    this.emit("close");
  }
}

const fake = () => {
  const socket = new FakeSocket();
  return { socket, ws: socket as unknown as WebSocket };
};
const log = { error() {}, warn() {} } as unknown as FastifyBaseLogger;
const signedIn = (ws: WebSocket, clerkId: string) =>
  keepAuthenticated(ws, { clerkId, verifyToken: async () => clerkId, log });

describe("a socket that doesn't read what it is sent", () => {
  test("is dropped once too much is waiting, instead of filling memory", () => {
    const { socket, ws } = fake();
    socket.bufferedAmount = MAX_BUFFERED_BYTES;
    sendText(ws, "fits");
    assert.deepEqual(socket.sent, ["fits"]);
    assert.equal(socket.terminated, false);

    socket.bufferedAmount = MAX_BUFFERED_BYTES + 1;
    sendJson(ws, { type: "study_state" });
    assert.deepEqual(socket.sent, ["fits"]);
    assert.equal(socket.terminated, true);
    // And nothing more goes to it
    sendText(ws, "late");
    assert.deepEqual(socket.sent, ["fits"]);
  });
});

describe("whole-state answers (sync)", () => {
  test("a short burst is answered at once; a loop gets one answer every two seconds", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
    const { socket, ws } = fake();
    signedIn(ws, "clerk_sync_loop");
    let answers = 0;
    const sync = limitedSync(ws, log, async () => void (answers += 1));

    for (let i = 0; i < 5; i++) await sync();
    assert.equal(answers, 5);
    // Over the allowance: not answered now, not dropped either
    for (let i = 0; i < 50; i++) await sync();
    assert.equal(answers, 5);

    t.mock.timers.tick(2_000);
    await Promise.resolve();
    assert.equal(answers, 6, "the requests that waited share one answer");
    t.mock.timers.tick(10_000);
    await Promise.resolve();
    assert.equal(answers, 6, "nothing is sent that wasn't asked for");

    socket.close();
  });

  test("the allowance is the user's, whichever of their sockets asks", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
    const a = fake();
    const b = fake();
    const other = fake();
    signedIn(a.ws, "clerk_two_tabs");
    signedIn(b.ws, "clerk_two_tabs");
    signedIn(other.ws, "clerk_someone_else");
    let answers = 0;
    const count = async () => void (answers += 1);
    const syncA = limitedSync(a.ws, log, count);
    const syncB = limitedSync(b.ws, log, count);
    const syncOther = limitedSync(other.ws, log, count);

    for (let i = 0; i < 5; i++) await syncA();
    await syncB();
    assert.equal(answers, 5, "a second socket doesn't bring a second allowance");
    await syncOther();
    assert.equal(answers, 6, "another user has their own");

    for (const { socket } of [a, b, other]) socket.close();
  });

  test("an answer that was waiting isn't sent to a socket that closed", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
    const { socket, ws } = fake();
    signedIn(ws, "clerk_gone");
    let answers = 0;
    const sync = limitedSync(ws, log, async () => void (answers += 1));
    for (let i = 0; i < 6; i++) await sync();
    socket.close();
    t.mock.timers.tick(5_000);
    await Promise.resolve();
    assert.equal(answers, 5);
  });

  test("a failure within the allowance reaches the caller", async () => {
    const { socket, ws } = fake();
    signedIn(ws, "clerk_failing");
    const sync = limitedSync(ws, log, async () => {
      throw new Error("no such room");
    });
    await assert.rejects(sync(), /no such room/);
    socket.close();
  });
});
