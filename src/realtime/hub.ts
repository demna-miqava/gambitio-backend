import { randomUUID } from "node:crypto";
import type { FastifyBaseLogger } from "fastify";
import type { WebSocket } from "ws";
import type { createClient } from "redis";

type RedisClient = ReturnType<typeof createClient>;

const CHANNEL = "gambitio:deliver";
const HEARTBEAT_MS = 25_000;
/** An instance that hasn't renewed its liveness key for this long is gone */
const INSTANCE_TTL_MS = 3 * HEARTBEAT_MS;
/**
 * Membership sets (presence, spectators) expire if nobody writes to them for
 * this long, so a crashed instance's entries don't stay in Redis forever.
 * Each instance renews the sets it has members in every KEY_REFRESH_MS.
 */
const KEY_TTL_MS = 6 * 60 * 60_000;
const KEY_REFRESH_MS = 60 * 60_000;

export type PresenceKind = "notifications" | "matchmaking";

/** Delivery addresses. A socket can listen on several. */
export const topics = {
  game: (gameId: number) => `game:${gameId}`,
  gameUser: (gameId: number, userId: number) => `game:${gameId}:user:${userId}`,
  notifications: (userId: number) => `notifications:user:${userId}`,
  matchmaking: (userId: number) => `matchmaking:user:${userId}`,
};

/**
 * Sent on a player's notifications topic when they start or finish a live
 * game, so the "Return to game" link updates without polling.
 */
export const activeGameMessage = (gameId: number | null) => ({ type: "active_game", data: { gameId } });

/** An entry in a Redis sorted set shared by all instances (presence, a game's spectators). */
interface Membership {
  key: string;
  member: string;
}

interface Attached {
  userId: number;
  topics: string[];
  presence: PresenceKind | undefined;
  memberships: Membership[];
  alive: boolean;
  onDetach: (() => Promise<void>) | undefined;
}

/** What goes over the Redis channel */
type Envelope =
  | { origin: string; topic: string; message: object }
  | { origin: string; closeUser: number };

/**
 * Routes WebSocket messages between server instances.
 *
 * - A publish is delivered to this instance's sockets straight away, then
 *   sent over a Redis channel for the other instances to deliver to theirs,
 *   so two players on different servers still reach each other.
 * - Connections are tracked per socket, so a second tab or a quick reconnect
 *   never drops the other socket.
 * - Presence ("is this user online for challenges?") is a Redis sorted set
 *   per user with one member per socket, tagged with the instance holding
 *   it. Each instance renews a single liveness key on a heartbeat (not one
 *   write per socket); readers ignore members of instances whose key has
 *   expired, so a crashed instance's sockets stop counting on their own.
 *   Other per-socket sets (a game's spectators) work the same way: see
 *   addMembership.
 * - Sockets that stop answering pings are terminated.
 */
export class RealtimeHub {
  readonly instanceId = randomUUID();
  private sub: RedisClient | null = null;
  private local = new Map<string, Set<WebSocket>>();
  private attached = new Map<WebSocket, Attached>();
  private socketsPerUser = new Map<number, number>();
  /** Local sockets per presence kind, and per (kind, user) */
  private presenceSockets = new Map<string, number>();
  private heartbeat: NodeJS.Timeout | null = null;
  private keyRefresh: NodeJS.Timeout | null = null;
  private socketSeq = 0;
  /** Set while shutting down: sockets close because of us, not the user */
  private stopping = false;

  constructor(
    private redis: RedisClient,
    private log: FastifyBaseLogger
  ) {}

  async start(): Promise<void> {
    await this.renewLiveness();
    this.sub = this.redis.duplicate();
    this.sub.on("error", (err) => this.log.error({ err }, "Redis subscriber error"));
    await this.sub.connect();
    await this.sub.subscribe(CHANNEL, (raw) => this.onEnvelope(raw));
    this.heartbeat = setInterval(() => void this.beat(), HEARTBEAT_MS);
    this.keyRefresh = setInterval(() => void this.refreshKeys(), KEY_REFRESH_MS);
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.heartbeat) clearInterval(this.heartbeat);
    if (this.keyRefresh) clearInterval(this.keyRefresh);
    for (const socket of this.attached.keys()) socket.close(1001, "Server shutting down");
    await Promise.all([...this.attached.keys()].map((s) => this.detach(s)));
    await this.redis.del(instanceKey(this.instanceId)).catch(() => {});
    if (this.sub) await this.sub.quit();
  }

  /** Registers a socket on topics (and optionally presence); cleans up when it closes. */
  async attach(
    socket: WebSocket,
    options: {
      userId: number;
      topics: string[];
      presence?: PresenceKind;
      /** Runs after the socket has been removed (and its presence cleared) */
      onDetach?: (() => Promise<void>) | undefined;
    }
  ): Promise<void> {
    const entry: Attached = {
      userId: options.userId,
      topics: options.topics,
      presence: options.presence,
      memberships: options.presence
        ? [{ key: presenceKey(options.presence, options.userId), member: this.memberId(options.userId) }]
        : [],
      alive: true,
      onDetach: options.onDetach,
    };
    this.attached.set(socket, entry);
    this.socketsPerUser.set(entry.userId, this.userSocketCount(entry.userId) + 1);
    if (entry.presence) {
      this.bump(entry.presence, 1);
      this.bump(`${entry.presence}:${entry.userId}`, 1);
    }
    for (const topic of entry.topics) {
      let set = this.local.get(topic);
      if (!set) this.local.set(topic, (set = new Set()));
      set.add(socket);
    }
    socket.on("pong", () => {
      entry.alive = true;
    });
    socket.on("close", () => void this.detach(socket));
    for (const membership of entry.memberships) await this.addMember(membership);
  }

  /**
   * Adds an attached socket to a Redis set shared by all instances (e.g. a
   * game's spectators). It is removed when the socket closes; a crashed
   * instance's entries stop counting once its liveness key expires.
   * Returns false (and adds nothing) if the socket has already gone.
   */
  async addMembership(socket: WebSocket, key: string): Promise<boolean> {
    const entry = this.attached.get(socket);
    if (!entry) return false;
    const membership = { key, member: this.memberId(entry.userId) };
    entry.memberships.push(membership);
    await this.addMember(membership);
    // Closed while we were writing: detach may have run before the write
    if (!this.attached.has(socket)) {
      await this.redis.zRem(key, membership.member).catch(() => {});
      return false;
    }
    return true;
  }

  /** Distinct users with a live socket in a membership set, across all instances. */
  async countMembers(key: string): Promise<number> {
    const members = await this.liveMembers(key);
    return new Set(members.map((m) => m.slice(0, m.indexOf(":")))).size;
  }

  /** Unique per socket: "<userId>:<instanceId>:<seq>", so sets can count distinct users. */
  private memberId(userId: number): string {
    return `${userId}:${this.instanceId}:${++this.socketSeq}`;
  }

  /**
   * Members of a set whose instance is still alive. Members of dead
   * instances are removed as they are found.
   */
  private async liveMembers(key: string): Promise<string[]> {
    const members = await this.redis.zRange(key, 0, -1);
    const others = [...new Set(members.map(instanceOf))].filter((id) => id !== this.instanceId);
    if (others.length === 0) return members;
    const flags = await this.redis.mGet(others.map(instanceKey));
    const dead = new Set(others.filter((_, i) => flags[i] === null));
    if (dead.size === 0) return members;
    const stale = members.filter((m) => dead.has(instanceOf(m)));
    await this.redis.zRem(key, stale).catch(() => {});
    return members.filter((m) => !dead.has(instanceOf(m)));
  }

  private async detach(socket: WebSocket): Promise<void> {
    const entry = this.attached.get(socket);
    if (!entry) return;
    this.attached.delete(socket);
    const remaining = this.userSocketCount(entry.userId) - 1;
    if (remaining > 0) this.socketsPerUser.set(entry.userId, remaining);
    else this.socketsPerUser.delete(entry.userId);
    if (entry.presence) {
      this.bump(entry.presence, -1);
      this.bump(`${entry.presence}:${entry.userId}`, -1);
    }
    for (const topic of entry.topics) {
      const set = this.local.get(topic);
      set?.delete(socket);
      if (set?.size === 0) this.local.delete(topic);
    }
    for (const { key, member } of entry.memberships) {
      await this.redis.zRem(key, member).catch(() => {});
    }
    // A shutdown isn't the user leaving: they reconnect to another instance
    if (this.stopping) return;
    await entry.onDetach?.().catch((err) => this.log.error({ err }, "onDetach failed"));
  }

  get isStopping(): boolean {
    return this.stopping;
  }

  /**
   * Delivers to this instance's sockets at once (no Redis round trip before
   * players see a move), then hands the message to the other instances.
   */
  async publish(topic: string, message: object): Promise<void> {
    this.deliverLocal(topic, JSON.stringify(message));
    const envelope: Envelope = { origin: this.instanceId, topic, message };
    await this.redis.publish(CHANNEL, JSON.stringify(envelope));
  }

  /** Closes every socket a user holds, on all instances (their account is gone). */
  async closeUserSockets(userId: number): Promise<void> {
    this.closeLocal(userId);
    const envelope: Envelope = { origin: this.instanceId, closeUser: userId };
    await this.redis.publish(CHANNEL, JSON.stringify(envelope));
  }

  async isPresent(kind: PresenceKind, userId: number): Promise<boolean> {
    if ((this.presenceSockets.get(`${kind}:${userId}`) ?? 0) > 0) return true;
    return (await this.liveMembers(presenceKey(kind, userId))).length > 0;
  }

  /** Sockets this instance holds for a user, across all socket types. */
  userSocketCount(userId: number): number {
    return this.socketsPerUser.get(userId) ?? 0;
  }

  /** Sockets this instance holds with the given presence kind. */
  presenceCount(kind: PresenceKind): number {
    return this.presenceSockets.get(kind) ?? 0;
  }

  /** All sockets this instance holds. */
  get attachedCount(): number {
    return this.attached.size;
  }

  /** Number of sockets this instance holds for a topic (used by tests and logs). */
  localCount(topic: string): number {
    return this.local.get(topic)?.size ?? 0;
  }

  private bump(key: string, by: number): void {
    const next = (this.presenceSockets.get(key) ?? 0) + by;
    if (next > 0) this.presenceSockets.set(key, next);
    else this.presenceSockets.delete(key);
  }

  private onEnvelope(raw: string): void {
    let parsed: Partial<Envelope> & { topic?: string; message?: object; closeUser?: number };
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }
    // Already delivered locally by publish()
    if (parsed.origin === this.instanceId) return;
    if (typeof parsed.closeUser === "number") return this.closeLocal(parsed.closeUser);
    if (typeof parsed.topic === "string" && parsed.message) {
      this.deliverLocal(parsed.topic, JSON.stringify(parsed.message));
    }
  }

  private deliverLocal(topic: string, payload: string): void {
    const sockets = this.local.get(topic);
    if (!sockets) return;
    for (const socket of sockets) {
      if (socket.readyState === socket.OPEN) socket.send(payload);
    }
  }

  private closeLocal(userId: number): void {
    for (const [socket, entry] of this.attached) {
      if (entry.userId === userId) socket.close(4001, "Account deleted");
    }
  }

  private async addMember({ key, member }: Membership) {
    await this.redis.multi().zAdd(key, { score: Date.now(), value: member }).pExpire(key, KEY_TTL_MS).exec();
  }

  private async renewLiveness() {
    await this.redis.set(instanceKey(this.instanceId), "1", {
      expiration: { type: "PX", value: INSTANCE_TTL_MS },
    });
  }

  /** Pings every socket (terminating ones that never answered) and renews this instance's liveness. */
  private async beat(): Promise<void> {
    for (const [socket, entry] of this.attached) {
      if (!entry.alive) {
        socket.terminate();
        continue;
      }
      entry.alive = false;
      socket.ping();
    }
    await this.renewLiveness().catch((err) => this.log.error({ err }, "Renewing instance liveness failed"));
  }

  /** Keeps the sets this instance has members in from expiring. One command per set per hour. */
  private async refreshKeys(): Promise<void> {
    const keys = new Set<string>();
    for (const entry of this.attached.values()) for (const m of entry.memberships) keys.add(m.key);
    for (const key of keys) await this.redis.pExpire(key, KEY_TTL_MS).catch(() => {});
  }
}

function presenceKey(kind: PresenceKind, userId: number) {
  return `presence:${kind}:${userId}`;
}

function instanceKey(instanceId: string) {
  return `instance:${instanceId}`;
}

function instanceOf(member: string): string {
  return member.split(":")[1] ?? "";
}
