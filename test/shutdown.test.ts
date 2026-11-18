import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { FastifyInstance } from "fastify";
import { installShutdownHandlers } from "../src/shutdown.js";

const flush = async () => {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
};

test("a second SIGTERM during shutdown is ignored, so the pause and close still finish", async () => {
  const steps: string[] = [];
  let finishPause!: () => void;
  const app = {
    log: { info: () => {}, error: () => {} },
    liveGames: {
      pauseForShutdown: () =>
        new Promise<number>((resolve) => {
          steps.push("pause started");
          finishPause = () => {
            steps.push("paused");
            resolve(1);
          };
        }),
    },
    close: async () => void steps.push("closed"),
  };
  const proc = Object.assign(new EventEmitter(), {
    exit: (code: number) => void steps.push(`exit ${code}`),
  });
  installShutdownHandlers(app as unknown as FastifyInstance, proc);

  proc.emit("SIGTERM");
  await flush();
  // More signals while the pause is still being written
  assert.ok(proc.listenerCount("SIGTERM") > 0, "still handled: no default exit");
  proc.emit("SIGTERM");
  proc.emit("SIGINT");
  await flush();
  assert.deepEqual(steps, ["pause started"], "the repeats start nothing");

  finishPause();
  await flush();
  assert.deepEqual(steps, ["pause started", "paused", "closed", "exit 0"]);
});
