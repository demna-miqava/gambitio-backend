import type { WebSocket } from "ws";

/**
 * The network round trip between the server and a player, measured by the
 * server itself, so lag compensation doesn't rest on the client's word (see
 * MAX_LAG_COMPENSATION_MS in src/game/clock.ts).
 *
 * Two sources, because it isn't known whether Cloudflare answers WebSocket
 * pings itself before they reach the browser (the ping round trip is then
 * only server to edge, near zero) or passes them on:
 * - WebSocket pings with a payload, every RTT_PING_EVERY_MS, the estimate
 *   being the median of the last RTT_SAMPLES round trips;
 * - the TCP round trip Cloudflare measured to the browser, which the Worker
 *   passes in CLIENT_RTT_HEADER on the handshake (worker/index.ts).
 * The larger of the two counts.
 */

export const RTT_PING_EVERY_MS = 2_000;
const RTT_SAMPLES = 5;
/** Pings awaiting their pong; older ones are forgotten (their pong then doesn't count) */
const MAX_PENDING_PINGS = 4;
/** Any round trip is taken as at most this much */
export const MAX_RTT_MS = 1_000;
/**
 * Set by the Worker from request.cf.clientTcpRtt; the Worker deletes any
 * value a client sends, so only Cloudflare's measurement gets here.
 */
export const CLIENT_RTT_HEADER = "x-gambitio-client-rtt";
/** Tells this probe's pongs apart from the hub's liveness pings, which have no payload */
const PAYLOAD_PREFIX = "rtt:";

/** The Worker's TCP round trip header, in ms (0..MAX_RTT_MS), or undefined if missing or garbage. */
export function parseClientRtt(value: string | string[] | undefined): number | undefined {
  if (typeof value !== "string" || !/^\d{1,9}(\.\d+)?$/.test(value.trim())) return undefined;
  const ms = Number(value);
  if (!Number.isFinite(ms) || ms <= 0) return undefined;
  return Math.min(MAX_RTT_MS, Math.round(ms));
}

export function median(values: number[]): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : Math.round((sorted[mid - 1]! + sorted[mid]!) / 2);
}

/** The round trip that counts: the larger of the two sources, or undefined without either. */
export function measuredRtt(pingMs: number | undefined, tcpMs: number | undefined): number | undefined {
  if (pingMs === undefined) return tcpMs;
  if (tcpMs === undefined) return pingMs;
  return Math.max(pingMs, tcpMs);
}

/**
 * Pings one socket while it belongs to a player of a game in progress. Holds
 * a single interval and a handful of numbers; stop() (or the socket
 * closing) removes both the interval and the pong listener.
 */
export class RttProbe {
  private samples: number[] = [];
  /** Sequence number -> when its ping went out (performance.now()) */
  private pending = new Map<number, number>();
  private seq = 0;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private socket: WebSocket,
    /** Cloudflare's TCP round trip at the handshake, if the Worker sent it */
    readonly tcpMs: number | undefined,
    private everyMs = RTT_PING_EVERY_MS
  ) {}

  start(): void {
    if (this.timer) return;
    this.socket.on("pong", this.onPong);
    this.socket.once("close", this.stop);
    this.ping();
    this.timer = setInterval(() => this.ping(), this.everyMs);
    this.timer.unref();
  }

  /** Safe to call more than once. */
  readonly stop = (): void => {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.pending.clear();
    this.socket.off("pong", this.onPong);
    this.socket.off("close", this.stop);
  };

  /** Median of the recent ping round trips, if any came back. */
  get pingMs(): number | undefined {
    return median(this.samples);
  }

  /** The round trip to use for lag compensation (see measuredRtt). */
  get measuredMs(): number | undefined {
    return measuredRtt(this.pingMs, this.tcpMs);
  }

  private ping(): void {
    if (this.socket.readyState !== this.socket.OPEN) return;
    const seq = ++this.seq;
    this.pending.set(seq, performance.now());
    // Map order is insertion order: the first key is the oldest ping
    if (this.pending.size > MAX_PENDING_PINGS) this.pending.delete(this.pending.keys().next().value!);
    this.socket.ping(`${PAYLOAD_PREFIX}${seq}`);
  }

  private onPong = (data: Buffer): void => {
    const text = data.toString();
    if (!text.startsWith(PAYLOAD_PREFIX)) return;
    const seq = Number(text.slice(PAYLOAD_PREFIX.length));
    const sentAt = this.pending.get(seq);
    if (sentAt === undefined) return;
    this.pending.delete(seq);
    this.samples.push(Math.min(MAX_RTT_MS, Math.round(performance.now() - sentAt)));
    if (this.samples.length > RTT_SAMPLES) this.samples.shift();
  };
}
