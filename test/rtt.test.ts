import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { WebSocket } from "ws";
import { MAX_RTT_MS, measuredRtt, median, parseClientRtt, RttProbe, CLIENT_RTT_HEADER } from "../src/routes/ws/rttProbe.js";
import { backendHeaders, CLIENT_RTT_HEADER as WORKER_HEADER } from "../worker/clientRtt.js";
import type { FastifyInstance } from "fastify";
import { LiveGameService, type LiveMoveTiming } from "../src/services/liveGameService.js";
import type { RealtimeHub } from "../src/realtime/hub.js";
import type { ClockState } from "../src/game/clock.js";

/** Enough of a ws socket for the probe: answers each ping after `delayMs` (or never). */
class FakeSocket extends EventEmitter {
  readonly OPEN = 1;
  readyState = 1;
  pings: string[] = [];
  constructor(private delayMs: number | null) {
    super();
  }
  ping(data: string) {
    this.pings.push(data);
    if (this.delayMs !== null) setTimeout(() => this.emit("pong", Buffer.from(data)), this.delayMs);
  }
}

test("the Worker's TCP round trip header is read defensively", () => {
  assert.equal(parseClientRtt("42"), 42);
  assert.equal(parseClientRtt("42.6"), 43);
  assert.equal(parseClientRtt("5000"), MAX_RTT_MS);
  for (const garbage of [undefined, "", "0", "-5", "abc", "1e3", "NaN", "12ms", ["1", "2"]]) {
    assert.equal(parseClientRtt(garbage as string | undefined), undefined, String(garbage));
  }
});

test("the round trip is the median of the pings or the TCP one, whichever is larger", () => {
  assert.equal(median([]), undefined);
  assert.equal(median([30, 10, 500, 20, 25]), 25);
  assert.equal(median([10, 20]), 15);
  assert.equal(measuredRtt(undefined, undefined), undefined);
  assert.equal(measuredRtt(5, undefined), 5);
  assert.equal(measuredRtt(undefined, 80), 80);
  assert.equal(measuredRtt(5, 80), 80, "pings answered at the edge don't hide the real trip");
  assert.equal(measuredRtt(120, 80), 120);
});

test("the probe measures its own pongs and ignores the hub's", async () => {
  const socket = new FakeSocket(30);
  const probe = new RttProbe(socket as unknown as WebSocket, undefined, 40);
  probe.start();
  // A liveness pong (no payload) and a stray one don't count
  socket.emit("pong", Buffer.alloc(0));
  socket.emit("pong", Buffer.from("rtt:999"));
  await new Promise((resolve) => setTimeout(resolve, 230));
  probe.stop();
  const pings = socket.pings.length;
  assert.ok(pings >= 4, `pinged every interval: ${pings}`);
  assert.ok(probe.pingMs! >= 25 && probe.pingMs! < 80, `measured ${probe.pingMs}`);
  assert.equal(probe.measuredMs, probe.pingMs);

  // Stopped: no more pings, no listeners left behind
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(socket.pings.length, pings);
  assert.equal(socket.listenerCount("pong"), 0);
  assert.equal(socket.listenerCount("close"), 0);
});

test("a socket that never answers leaves only the TCP round trip, and closing stops the probe", async () => {
  const socket = new FakeSocket(null);
  const probe = new RttProbe(socket as unknown as WebSocket, 70, 10);
  probe.start();
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(probe.pingMs, undefined);
  assert.equal(probe.measuredMs, 70);
  socket.emit("close");
  const pings = socket.pings.length;
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(socket.pings.length, pings);
  assert.equal(socket.listenerCount("pong"), 0);
});

test("the Worker only lets Cloudflare's round trip through, on game sockets", () => {
  assert.equal(WORKER_HEADER, CLIENT_RTT_HEADER, "the Worker and the backend agree on the header");
  const forged = new Headers({ [CLIENT_RTT_HEADER]: "999", upgrade: "websocket" });

  const game = backendHeaders("https://site.test/api/ws/game/12", forged, 37.4);
  assert.equal(game?.get(CLIENT_RTT_HEADER), "37");
  assert.equal(game?.get("upgrade"), "websocket", "the upgrade survives");

  const gameWithoutRtt = backendHeaders("https://site.test/api/ws/game/12", forged, undefined);
  assert.equal(gameWithoutRtt?.has(CLIENT_RTT_HEADER), false, "a client's value is dropped");
  assert.equal(backendHeaders("https://site.test/api/ws/game/12", forged, 0)?.has(CLIENT_RTT_HEADER), false);

  const other = backendHeaders("https://site.test/api/users/me", forged, 37);
  assert.equal(other?.has(CLIENT_RTT_HEADER), false, "not for other paths");

  // Nothing to change: the request goes through as it is
  assert.equal(backendHeaders("https://site.test/api/users/me", new Headers(), 37), null);
});

test("pongs answered late to stretch the ping round trip get the move logged", () => {
  const logged: string[] = [];
  const fastify = { log: { info: (_fields: object, message: string) => logged.push(message) } };
  const service = new LiveGameService(fastify as unknown as FastifyInstance, {} as RealtimeHub);
  const noteLag = (service as unknown as {
    noteLag(game: { id: number }, userId: number, state: ClockState, now: number, timing: LiveMoveTiming): void;
  }).noteLag.bind(service);
  const state: ClockState = { whiteMs: 60_000, blackMs: 60_000, lastMoveAt: 0, ply: 10 };
  // Pings answered 950ms late over a 15ms TCP round trip; the client claims just that
  const stretched = { pingMs: 950, tcpMs: 15 };
  noteLag({ id: 1 }, 7, state, 1_500, {
    thinkMs: 550,
    measuredRttMs: measuredRtt(stretched.pingMs, stretched.tcpMs),
    rttSources: stretched,
  });
  assert.deepEqual(logged, ["Move forgiven more network delay than the TCP round trip backs"]);
  // An honest player near the edge isn't
  const near = { pingMs: 40, tcpMs: 15 };
  noteLag({ id: 2 }, 8, state, 1_500, { thinkMs: 1_460, measuredRttMs: 40, rttSources: near });
  assert.equal(logged.length, 1);
});
