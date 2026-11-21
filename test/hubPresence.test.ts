import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { FastifyBaseLogger } from "fastify";
import type { WebSocket } from "ws";
import { RealtimeHub, REMOTE_PRESENCE_CACHE_MS } from "../src/realtime/hub.js";

/**
 * RealtimeHub.presentUserIds over a fake Redis that counts the commands it
 * is sent (Redis is billed per command). No Redis needed.
 */
class FakeSocket extends EventEmitter {
  readonly OPEN = 1;
  readonly CLOSED = 3;
  readyState = 1;
  closedWith: number | undefined;
  ping() {}
  terminate() {}
  send() {}
  close(code?: number) {
    this.closedWith = code;
    this.readyState = this.CLOSED;
    this.emit("close");
  }
}

function fakeRedis(sets: Record<string, string[]>, aliveInstances: string[]) {
  const commands: string[] = [];
  const redis = {
    commands,
    async zRange(key: string) {
      commands.push(`ZRANGE ${key}`);
      return sets[key] ?? [];
    },
    async mGet(keys: string[]) {
      commands.push(`MGET ${keys.join(" ")}`);
      return keys.map((key) => (aliveInstances.some((id) => key === `instance:${id}`) ? "1" : null));
    },
    async zRem(key: string, members: string | string[]) {
      commands.push("ZREM");
      const gone = new Set([members].flat());
      if (sets[key]) sets[key] = sets[key].filter((m) => !gone.has(m));
      return gone.size;
    },
    multi() {
      const chain = {
        zAdd: () => chain,
        pExpire: () => chain,
        exec: async () => {
          commands.push("MULTI");
          return [];
        },
      };
      return chain;
    },
  };
  return redis;
}

const log = { error() {}, warn() {}, info() {} } as unknown as FastifyBaseLogger;

/** A hub over `redis`; `heard` makes it hear another instance's heartbeat (see othersAlive) */
function hubOver(redis: ReturnType<typeof fakeRedis>) {
  const hub = new RealtimeHub(redis as never, log);
  const heard = () =>
    (hub as unknown as { onEnvelope(raw: string): void }).onEnvelope(JSON.stringify({ origin: "other", beat: true }));
  return { hub, heard };
}

test("alone (no other instance heard from), presence needs no Redis command at all", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
  const redis = fakeRedis({ "presence:notifications:2": ["2:other:1"] }, ["other"]);
  const { hub } = hubOver(redis);
  await hub.attach(new FakeSocket() as unknown as WebSocket, { userId: 1, topics: [], presence: "notifications" });
  redis.commands.length = 0;

  // A new instance may not have heard the others yet: it reads Redis for
  // its first INSTANCE_TTL_MS (75 s)
  assert.deepEqual([...(await hub.presentUserIds("notifications", [1, 2]))].sort(), [1, 2]);
  assert.equal(redis.commands.filter((c) => c.startsWith("ZRANGE")).length, 1);

  // Then, with nobody else heard from, only this instance's sockets count
  t.mock.timers.tick(80_000);
  redis.commands.length = 0;
  assert.deepEqual([...(await hub.presentUserIds("notifications", [1, 2, 3]))], [1]);
  assert.deepEqual(redis.commands, []);
});

test("with other instances alive, remote answers are reused for a while", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
  const sets = { "presence:notifications:2": ["2:other:1"], "presence:notifications:3": ["3:dead:1"] };
  const redis = fakeRedis(sets, ["other"]);
  const { hub, heard } = hubOver(redis);
  t.mock.timers.tick(80_000);
  heard();

  assert.deepEqual([...(await hub.presentUserIds("notifications", [2, 3, 4]))], [2]);
  // One read per user, plus one liveness read for the instances found
  assert.equal(redis.commands.length, 4);

  // The same users again soon (another friends list, the next poll): no Redis
  redis.commands.length = 0;
  t.mock.timers.tick(REMOTE_PRESENCE_CACHE_MS - 1_000);
  assert.deepEqual([...(await hub.presentUserIds("notifications", [3, 2, 4]))], [2]);
  assert.deepEqual(redis.commands, []);
  // Another kind is a different question
  await hub.presentUserIds("matchmaking", [2]);
  assert.deepEqual(redis.commands, ["ZRANGE presence:matchmaking:2"]);

  // After the cache's time, a change on the other instance is seen
  delete (sets as Record<string, string[]>)["presence:notifications:2"];
  t.mock.timers.tick(2_000);
  heard();
  redis.commands.length = 0;
  assert.deepEqual([...(await hub.presentUserIds("notifications", [2, 3, 4]))], []);
  assert.equal(redis.commands.length, 4);
});

test("a socket on this instance counts at once, whatever was cached", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
  const redis = fakeRedis({}, []);
  const { hub, heard } = hubOver(redis);
  heard();
  assert.deepEqual([...(await hub.presentUserIds("notifications", [5]))], []);
  const socket = new FakeSocket();
  await hub.attach(socket as unknown as WebSocket, { userId: 5, topics: [], presence: "notifications" });
  redis.commands.length = 0;
  assert.deepEqual([...(await hub.presentUserIds("notifications", [5]))], [5]);
  assert.deepEqual(redis.commands, []);
});

test("isPresent still reads Redis for a user with no socket here", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
  const redis = fakeRedis({ "presence:notifications:2": ["2:other:1"] }, ["other"]);
  const { hub } = hubOver(redis);
  t.mock.timers.tick(80_000);
  // Even alone and with a cached answer: its callers (challenges) get what Redis says
  assert.deepEqual([...(await hub.presentUserIds("notifications", [2]))], []);
  assert.equal(await hub.isPresent("notifications", 2), true);
});

test("a member left in Redis by one of this instance's closed sockets doesn't count, and is removed", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
  const sets: Record<string, string[]> = {};
  const redis = fakeRedis(sets, []);
  const { hub } = hubOver(redis);
  // Its removal failed (a Redis blip when the socket closed), or a lost
  // reply's add landed after the removal
  sets["presence:notifications:2"] = [`2:${hub.instanceId}:99`];
  t.mock.timers.tick(80_000);
  assert.equal(await hub.isPresent("notifications", 2), false);
  assert.deepEqual(sets["presence:notifications:2"], []);

  // A socket that is attached here does count
  const socket = new FakeSocket();
  await hub.attach(socket as unknown as WebSocket, { userId: 3, topics: [] });
  assert.equal(await hub.addMembership(socket as unknown as WebSocket, "spectators:1"), true);
  sets["spectators:1"] = [`3:${hub.instanceId}:1`];
  assert.equal(await hub.countMembers("spectators:1"), 1);
  socket.close();
  // Even if the Redis set still had it
  sets["spectators:1"] = [`3:${hub.instanceId}:1`];
  assert.equal(await hub.countMembers("spectators:1"), 0);
});

test("a shutdown closes the sockets with 1001 and isn't taken for the users leaving", async () => {
  const redis = fakeRedis({}, []);
  const { hub } = hubOver(redis);
  const socket = new FakeSocket();
  let detached = 0;
  await hub.attach(socket as unknown as WebSocket, {
    userId: 1,
    topics: ["t"],
    presence: "notifications",
    onDetach: async () => void detached++,
  });
  hub.closeForShutdown();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(socket.closedWith, 1001);
  assert.equal(hub.attachedCount, 0);
  assert.equal(hub.isStopping, true);
  assert.equal(detached, 0);
});
