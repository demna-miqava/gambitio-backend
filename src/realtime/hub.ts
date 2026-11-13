import { randomUUID } from "node:crypto";
import type { FastifyBaseLogger } from "fastify";
import type { WebSocket } from "ws";
import type { createClient } from "redis";

type RedisClient = ReturnType<typeof createClient>;

const CHANNEL = "gambitio:deliver";
const HEARTBEAT_MS = 25_000;
const PRESENCE_TTL_MS = 3 * HEARTBEAT_MS;

export type PresenceKind = "notifications" | "matchmaking";

/** Delivery addresses. A socket can listen on several. */
export const topics = {
  game: (gameId: number) => `game:${gameId}`,
  gameUser: (gameId: number, userId: number) => `game:${gameId}:user:${userId}`,
  notifications: (userId: number) => `notifications:user:${userId}`,
  matchmaking: (userId: number) => `matchmaking:user:${userId}`,
};

/** An entry in an expiring Redis sorted set (presence, a game's spectators). */
interface Membership {
  key: string;
  member: string;
}

interface Attached {
  userId: number;
  topics: string[];
  memberships: Membership[];
  alive: boolean;
  onDetach: (() => Promise<void>) | undefined;
}

/**
 * Routes WebSocket messages between server instances.
 *
 * - Every publish goes through a Redis channel and each instance delivers it
 *   to its own sockets, so two players on different servers still reach each
 *   other.
 * - Connections are tracked per socket, so a second tab or a quick reconnect
 *   never drops the other socket.
 * - Presence ("is this user online for challenges?") is a Redis sorted set
 *   per user with expiring members, refreshed by the heartbeat. A crashed
 *   instance's entries expire on their own. Other per-socket sets (a game's
 *   spectators) work the same way: see addMembership.
 * - Sockets that stop answering pings are terminated.
 */
export class RealtimeHub {
  readonly instanceId = randomUUID();
  private sub: RedisClient | null = null;
  private local = new Map<string, Set<WebSocket>>();
  private attached = new Map<WebSocket, Attached>();
  private socketsPerUser = new Map<number, number>();
  private heartbeat: NodeJS.Timeout | null = null;
  private socketSeq = 0;
  /** Set while shutting down: sockets close because of us, not the user */
  private stopping = false;

  constructor(
    private redis: RedisClient,
    private log: FastifyBaseLogger
  ) {}

  async start(): Promise<void> {
    this.sub = this.redis.duplicate();
    this.sub.on("error", (err) => this.log.error({ err }, "Redis subscriber error"));
    await this.sub.connect();
    await this.sub.subscribe(CHANNEL, (raw) => this.deliverLocal(raw));
    this.heartbeat = setInterval(() => void this.beat(), HEARTBEAT_MS);
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.heartbeat) clearInterval(this.heartbeat);
    for (const socket of this.attached.keys()) socket.close(1001, "Server shutting down");
    await Promise.all([...this.attached.keys()].map((s) => this.detach(s)));
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
      memberships: options.presence
        ? [{ key: presenceKey(options.presence, options.userId), member: this.memberId(options.userId) }]
        : [],
      alive: true,
      onDetach: options.onDetach,
    };
    this.attached.set(socket, entry);
    this.socketsPerUser.set(entry.userId, this.userSocketCount(entry.userId) + 1);
    for (const topic of entry.topics) {
      let set = this.local.get(topic);
      if (!set) this.local.set(topic, (set = new Set()));
      set.add(socket);
    }
    socket.on("pong", () => {
      entry.alive = true;
    });
    socket.on("close", () => void this.detach(socket));
    for (const membership of entry.memberships) await this.touch(membership);
  }

  /**
   * Adds an attached socket to an expiring Redis set shared by all instances
   * (e.g. a game's spectators). The heartbeat keeps the entry fresh and it is
   * removed when the socket closes; a crashed instance's entries expire.
   * Returns false (and adds nothing) if the socket has already gone.
   */
  async addMembership(socket: WebSocket, key: string): Promise<boolean> {
    const entry = this.attached.get(socket);
    if (!entry) return false;
    const membership = { key, member: this.memberId(entry.userId) };
    entry.memberships.push(membership);
    await this.touch(membership);
    // Closed while we were writing: detach may have run before the write
    if (!this.attached.has(socket)) {
      await this.redis.zRem(key, membership.member).catch(() => {});
      return false;
    }
    return true;
  }

  /** Distinct users with a live socket in a membership set, across all instances. */
  async countMembers(key: string): Promise<number> {
    await this.redis.zRemRangeByScore(key, "-inf", Date.now());
    const members = await this.redis.zRange(key, 0, -1);
    return new Set(members.map((m) => m.slice(0, m.indexOf(":")))).size;
  }

  /** Unique per socket; starts with the user id so sets can count distinct users. */
  private memberId(userId: number): string {
    return `${userId}:${this.instanceId}:${++this.socketSeq}`;
  }

  private async detach(socket: WebSocket): Promise<void> {
    const entry = this.attached.get(socket);
    if (!entry) return;
    this.attached.delete(socket);
    const remaining = this.userSocketCount(entry.userId) - 1;
    if (remaining > 0) this.socketsPerUser.set(entry.userId, remaining);
    else this.socketsPerUser.delete(entry.userId);
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

  async publish(topic: string, message: object): Promise<void> {
    await this.redis.publish(CHANNEL, JSON.stringify({ topic, message }));
  }

  async isPresent(kind: PresenceKind, userId: number): Promise<boolean> {
    const key = presenceKey(kind, userId);
    await this.redis.zRemRangeByScore(key, "-inf", Date.now());
    return (await this.redis.zCard(key)) > 0;
  }

  /** Sockets this instance holds for a user, across all socket types. */
  userSocketCount(userId: number): number {
    return this.socketsPerUser.get(userId) ?? 0;
  }

  /** Number of sockets this instance holds for a topic (used by tests and logs). */
  localCount(topic: string): number {
    return this.local.get(topic)?.size ?? 0;
  }

  private deliverLocal(raw: string): void {
    let parsed: { topic: string; message: object };
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }
    const sockets = this.local.get(parsed.topic);
    if (!sockets) return;
    const payload = JSON.stringify(parsed.message);
    for (const socket of sockets) {
      if (socket.readyState === socket.OPEN) socket.send(payload);
    }
  }

  private async touch({ key, member }: Membership) {
    await this.redis.zAdd(key, { score: Date.now() + PRESENCE_TTL_MS, value: member });
    await this.redis.pExpire(key, PRESENCE_TTL_MS);
  }

  private async beat(): Promise<void> {
    for (const [socket, entry] of this.attached) {
      if (!entry.alive) {
        socket.terminate();
        continue;
      }
      entry.alive = false;
      socket.ping();
      for (const membership of entry.memberships) await this.touch(membership).catch(() => {});
    }
  }
}

function presenceKey(kind: PresenceKind, userId: number) {
  return `presence:${kind}:${userId}`;
}
