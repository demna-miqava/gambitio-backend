import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { createClient } from "redis";
import { closeRedis } from "../src/plugins/redis.js";

test("a Redis client that is reconnecting is closed at once, where quit() would wait for ever", async () => {
  // A port nobody listens on: the client keeps trying to connect
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  await new Promise<void>((resolve) => server.close(() => resolve()));

  const client = createClient({ url: `redis://127.0.0.1:${port}`, disableOfflineQueue: true });
  client.on("error", () => {});
  const connecting = client.connect().catch(() => {});
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(client.isOpen, true);
  assert.equal(client.isReady, false);

  const started = Date.now();
  await closeRedis(client);
  assert.ok(Date.now() - started < 1_000);
  assert.equal(client.isOpen, false);
  await connecting;
  // Closing again is harmless
  await closeRedis(client);
});
