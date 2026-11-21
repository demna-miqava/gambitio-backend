import { test } from "node:test";
import assert from "node:assert/strict";
import type { FastifyInstance } from "fastify";
import type { LiveGame } from "../src/models/Game.js";
import { announceGameStart } from "../src/services/gameService.js";

/** Just what announceGameStart touches, recording what it did in order. */
function fakeApp(failing: Set<string>) {
  const calls: string[] = [];
  const app = {
    log: { error: () => void calls.push("logged") },
    liveGames: { watchDeadline: (gameId: number) => void calls.push(`deadline ${gameId}`) },
    hub: {
      publish: async (topic: string) => {
        calls.push(`publish ${topic}`);
        if (failing.has(topic)) throw new Error("Redis is down");
      },
    },
    challenges: { notifyDropped: async (rows: unknown[]) => void calls.push(`dropped ${rows.length}`) },
  };
  return { app: app as unknown as FastifyInstance, calls };
}

const game = (id: number) => ({ id, deadlineAt: new Date() }) as LiveGame;

test("arms every game's deadline, publishes, then tells dropped challenges", async () => {
  const { app, calls } = fakeApp(new Set());
  await announceGameStart(app, {
    games: [game(1), game(2)],
    messages: [
      { topic: "a", message: {} },
      { topic: "b", message: {} },
    ],
    dropped: [{ challengerId: 1, challengedId: 2 }],
  });
  assert.deepEqual(calls, ["deadline 1", "deadline 2", "publish a", "publish b", "dropped 1"]);
});

test("a failed publish is logged, and the rest still happens", async () => {
  const { app, calls } = fakeApp(new Set(["a"]));
  await announceGameStart(app, {
    games: [game(1)],
    messages: [
      { topic: "a", message: {} },
      { topic: "b", message: {} },
    ],
    dropped: [],
  });
  assert.ok(calls.includes("logged"));
  assert.ok(calls.includes("publish b"));
  assert.equal(calls.at(-1), "dropped 0");
});
