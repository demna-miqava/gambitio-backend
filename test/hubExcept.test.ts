import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { FastifyBaseLogger } from "fastify";
import type { WebSocket } from "ws";
import { RealtimeHub } from "../src/realtime/hub.js";

/**
 * RealtimeHub.subscribe and publishExcept (spectator chat), over a fake
 * Redis that records what is published. No Redis needed.
 */
class FakeSocket extends EventEmitter {
  readonly OPEN = 1;
  readonly CLOSED = 3;
  readyState = 1;
  bufferedAmount = 0;
  received: string[] = [];
  ping() {}
  terminate() {}
  send(payload: string) {
    this.received.push(payload);
  }
  close() {
    this.readyState = this.CLOSED;
    this.emit("close");
  }
}

function fakeRedis() {
  const published: string[] = [];
  return {
    published,
    async publish(_channel: string, raw: string) {
      published.push(raw);
      return 2;
    },
    async zRem() {
      return 0;
    },
    multi() {
      const chain = { zAdd: () => chain, pExpire: () => chain, exec: async () => [] };
      return chain;
    },
  };
}

const log = { error() {}, warn() {}, info() {} } as unknown as FastifyBaseLogger;
const TOPIC = "game:7:spectator-chat";

async function setup() {
  const redis = fakeRedis();
  const hub = new RealtimeHub(redis as never, log);
  const onEnvelope = (raw: string) => (hub as unknown as { onEnvelope(raw: string): void }).onEnvelope(raw);
  // Another instance is alive, so publishes go to Redis too
  onEnvelope(JSON.stringify({ origin: "other", beat: true }));
  const sockets = new Map<number, FakeSocket>();
  for (const userId of [1, 2, 3]) {
    const socket = new FakeSocket();
    await hub.attach(socket as unknown as WebSocket, { userId, topics: [`game:7:user:${userId}`] });
    sockets.set(userId, socket);
  }
  return { hub, redis, onEnvelope, sockets };
}

test("subscribe adds a topic to an attached socket, and it goes when the socket closes", async () => {
  const { hub, sockets } = await setup();
  const one = sockets.get(1)! as unknown as WebSocket;
  assert.equal(hub.subscribe(one, TOPIC), true);
  assert.equal(hub.subscribe(one, TOPIC), true);
  assert.equal(hub.localCount(TOPIC), 1);
  sockets.get(1)!.close();
  await new Promise((r) => setImmediate(r));
  assert.equal(hub.localCount(TOPIC), 0);
  // A socket that isn't attached can't be subscribed
  assert.equal(hub.subscribe(new FakeSocket() as unknown as WebSocket, TOPIC), false);
});

test("publishExcept skips excluded users here, and sends the list along to other instances", async () => {
  const { hub, redis, sockets } = await setup();
  for (const socket of sockets.values()) hub.subscribe(socket as unknown as WebSocket, TOPIC);
  await hub.publishExcept(TOPIC, { type: "spectator_chat", data: { text: "hi" } }, [2, 3]);
  assert.equal(sockets.get(1)!.received.length, 1);
  assert.equal(sockets.get(2)!.received.length, 0);
  assert.equal(sockets.get(3)!.received.length, 0);
  const envelope = JSON.parse(redis.published.at(-1)!);
  assert.deepEqual(envelope.except, [2, 3]);
  assert.equal(envelope.topic, TOPIC);
  // "except" comes before "topic", so a receiver can't take the fast path
  assert.ok(redis.published.at(-1)!.indexOf('"except"') < redis.published.at(-1)!.indexOf('"topic"'));
});

test("an envelope from another instance is filtered by its list; a malformed list delivers to nobody", async () => {
  const { hub, onEnvelope, sockets } = await setup();
  for (const socket of sockets.values()) hub.subscribe(socket as unknown as WebSocket, TOPIC);
  const message = { type: "spectator_chat", data: { text: "from elsewhere" } };
  onEnvelope(JSON.stringify({ origin: "other", except: [1], topic: TOPIC, message }));
  assert.deepEqual(
    [1, 2, 3].map((id) => sockets.get(id)!.received.length),
    [0, 1, 1]
  );
  for (const except of ["1", [1, "2"], null, { 0: 1 }]) {
    onEnvelope(JSON.stringify({ origin: "other", except, topic: TOPIC, message }));
  }
  assert.deepEqual(
    [1, 2, 3].map((id) => sockets.get(id)!.received.length),
    [0, 1, 1]
  );
});
