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
/**
 * How long presentUserIds reuses what it read about a user's presence on
 * other instances: under the friends list's 30 s poll, so each poll still
 * sees changes from the one before
 */
export const REMOTE_PRESENCE_CACHE_MS = 15_000;
/** Users whose remote presence is remembered at once (the oldest go first) */
const REMOTE_PRESENCE_CACHE_MAX = 10_000;

export type PresenceKind = "notifications" | "matchmaking";

/** Delivery addresses. A socket can listen on several. */
export const topics = {
  game: (gameId: number) => `game:${gameId}`,
  gameUser: (gameId: number, userId: number) => `game:${gameId}:user:${userId}`,
  notifications: (userId: number) => `notifications:user:${userId}`,
  matchmaking: (userId: number) => `matchmaking:user:${userId}`,
  study: (roomId: number) => `study:${roomId}`,
  studyUser: (roomId: number, userId: number) => `study:${roomId}:user:${userId}`,
  /** Everyone with a tournament's lobby open */
  tournament: (tournamentId: number) => `tournament:${tournamentId}`,
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
  | { origin: string; closeUser: number }
  | { origin: string; closeTopic: string; code: number; reason: string }
  /** "This instance is alive": sent on start and on every heartbeat */
  | { origin: string; beat: true };

/**
 * A message envelope as publish() writes it: the same text JSON.stringify
 * makes of { origin, topic, message }, with the message's own JSON pasted
 * in, so a message is stringified once. Receivers read origin and topic with
 * this and hand the rest on without parsing and re-stringifying it.
 */
const MESSAGE_ENVELOPE = /^\{"origin":"(?:[^"\\]|\\.)*","topic":("(?:[^"\\]|\\.)*"),"message":/;

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
  /**
   * Connections per user: from the handshake (reserveSocketSlot) until the
   * connection closes, attached to topics or not
   */
  private connectionsPerUser = new Map<number, number>();
  /**
   * When another instance was last heard from (its heartbeat or any of its
   * envelopes). Starts at "now" so a new instance publishes to Redis until it
   * has had time to hear everyone's heartbeat: see othersAlive.
   */
  private othersSeenAt = Date.now();
  /**
   * presentUserIds' answers for users with no socket here, by
   * "<kind>:<userId>", oldest first: whether they had one on another live
   * instance, and when that was read
   */
  private remotePresence = new Map<string, { present: boolean; at: number }>();
  /** Starts every envelope this instance sends, to drop our own echoes unread */
  private readonly ownPrefix = `{"origin":${JSON.stringify(this.instanceId)},`;

  constructor(
    private redis: RedisClient,
    private log: FastifyBaseLogger
  ) {}

  async start(): Promise<void> {
    this.othersSeenAt = Date.now();
    await this.renewLiveness();
    this.sub = this.redis.duplicate();
    this.sub.on("error", (err) => this.log.error({ err }, "Redis subscriber error"));
    await this.sub.connect();
    await this.sub.subscribe(CHANNEL, (raw) => this.onEnvelope(raw));
    // Subscribed first, then announced: the instances already running start
    // publishing to Redis again the moment this arrives, before this one
    // serves its first request
    await this.announce();
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
    // Closed while the route was still preparing (a lookup it awaited before
    // attaching): its "close" event has already fired, so nothing would ever
    // detach it. It would stay on its topics, and in its presence sets, for
    // as long as this instance runs
    if (socket.readyState === socket.CLOSED) return;
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

  /** Distinct users with a live socket in a membership set, across all instances. */
  async memberUserIds(key: string): Promise<number[]> {
    const members = await this.liveMembers(key);
    return [...new Set(members.map((m) => Number(m.slice(0, m.indexOf(":")))))].filter(Number.isInteger);
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
   * Whether another instance may be running and listening on the channel:
   * one was heard from (a heartbeat every HEARTBEAT_MS, or any envelope)
   * within INSTANCE_TTL_MS, or this instance started less than that long
   * ago. No Redis read: it is kept up to date by the subscription. While it
   * is false nothing needs to cross instances, so publish() skips Redis and
   * sweeps that only matter for other instances can skip their work.
   *
   * A new instance announces itself as soon as it has subscribed, before it
   * serves anything, so the running ones resume publishing straight away;
   * the only messages it can miss are ones published in the moment the
   * announcement is in flight, before any of its sockets exist. It also
   * assumes others are alive for its own first INSTANCE_TTL_MS, until it has
   * heard their heartbeats. An instance that stops is still published to
   * for up to INSTANCE_TTL_MS, which is harmless.
   */
  get othersAlive(): boolean {
    return Date.now() - this.othersSeenAt < INSTANCE_TTL_MS;
  }

  /**
   * Delivers to this instance's sockets at once (no Redis round trip before
   * players see a move), then hands the message to the other instances,
   * unless none is running (othersAlive). The Redis command is issued before
   * this returns, and commands on one connection run in order, so callers
   * don't need to await one publish before the next to keep them in order;
   * the promise is for callers that want to know it failed. A failure is
   * also logged, so a publish nobody awaits can't become an unhandled rejection.
   */
  publish(topic: string, message: object): Promise<void> {
    const payload = JSON.stringify(message);
    this.deliverLocal(topic, payload);
    if (!this.othersAlive) return Promise.resolve();
    // Exactly what JSON.stringify({ origin, topic, message }) would write
    return this.send(
      `${this.ownPrefix}"topic":${JSON.stringify(topic)},"message":${payload}}`
    );
  }

  /** Closes every socket a user holds, on all instances (their account is gone). */
  closeUserSockets(userId: number): Promise<void> {
    this.closeLocal(userId);
    if (!this.othersAlive) return Promise.resolve();
    const envelope: Envelope = { origin: this.instanceId, closeUser: userId };
    return this.send(JSON.stringify(envelope));
  }

  /**
   * Closes every socket listening on a topic, on all instances (e.g. a study
   * room someone was removed from, or one that was deleted).
   */
  closeTopicSockets(topic: string, code = 4003, reason = "Access removed"): Promise<void> {
    this.closeTopicLocal(topic, code, reason);
    if (!this.othersAlive) return Promise.resolve();
    const envelope: Envelope = { origin: this.instanceId, closeTopic: topic, code, reason };
    return this.send(JSON.stringify(envelope));
  }

  private send(raw: string): Promise<void> {
    // Whether Redis counts our own subscriber among the receivers. While it
    // is down (reconnecting, or not started) it doesn't, and one receiver
    // is another instance. Checked when sending and again on the reply, so
    // a subscriber that drops in between can't make us think we're alone.
    const listeningAtSend = this.sub?.isReady === true;
    let published: Promise<number>;
    try {
      published = this.redis.publish(CHANNEL, raw);
    } catch (err) {
      // A client that is closing may throw rather than reject
      published = Promise.reject(err);
    }
    const sent = published.then((receivers) => {
      // Our own subscriber is one of them (if it is up): more means another
      // instance is listening
      const self = listeningAtSend && this.sub?.isReady === true ? 1 : 0;
      if (receivers > self) this.othersSeenAt = Date.now();
    });
    sent.catch((err) => this.log.warn({ err }, "Publishing to other instances failed"));
    return sent;
  }

  /** Tells the other instances this one is alive (on start and every heartbeat). */
  private async announce(): Promise<void> {
    const envelope: Envelope = { origin: this.instanceId, beat: true };
    await this.send(JSON.stringify(envelope)).catch(() => {});
  }

  /**
   * Takes one of a user's MAX socket slots on this instance for a WebSocket
   * handshake, or returns null if they are all taken. Counted from the
   * handshake rather than from attach(), so many handshakes at once can't
   * all pass the check before any of them is counted. Call the returned
   * function when the connection closes (whether or not it ever upgraded or
   * attached); calling it again does nothing.
   */
  reserveSocketSlot(userId: number, max: number): (() => void) | null {
    const held = this.connectionsPerUser.get(userId) ?? 0;
    if (held >= max) return null;
    this.connectionsPerUser.set(userId, held + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const remaining = (this.connectionsPerUser.get(userId) ?? 1) - 1;
      if (remaining > 0) this.connectionsPerUser.set(userId, remaining);
      else this.connectionsPerUser.delete(userId);
    };
  }

  /** Connections a user holds on this instance, including handshakes under way. */
  userConnectionCount(userId: number): number {
    return this.connectionsPerUser.get(userId) ?? 0;
  }

  async isPresent(kind: PresenceKind, userId: number): Promise<boolean> {
    if ((this.presenceSockets.get(`${kind}:${userId}`) ?? 0) > 0) return true;
    return (await this.liveMembers(presenceKey(kind, userId))).length > 0;
  }

  /**
   * Which of these users are present (isPresent) for this kind, on any
   * instance: for a friends list, not for the whole site, and polled (GET
   * /friends/status), so it is kept cheap in Redis commands:
   *
   * - Users with a socket here need no Redis read.
   * - While no other instance is alive (othersAlive, the rule publish()
   *   uses, which holds for a new instance's first INSTANCE_TTL_MS) nobody
   *   can have a socket elsewhere, so nothing is read at all.
   * - Otherwise each other user costs one read (sent together; node-redis
   *   pipelines them into one round trip), plus one liveness read for the
   *   other instances found, and the answer is reused for
   *   REMOTE_PRESENCE_CACHE_MS, so friends lists that overlap and polls
   *   close together don't repeat it. A user can so show online or offline
   *   that long after they changed on another instance.
   *
   * Members of this instance whose socket is no longer counted here are on
   * their way out (detach removes them from Redis just after), so they
   * don't count.
   */
  async presentUserIds(kind: PresenceKind, userIds: readonly number[]): Promise<Set<number>> {
    const present = new Set<number>();
    const remote: number[] = [];
    const othersAlive = this.othersAlive;
    const now = Date.now();
    for (const userId of new Set(userIds)) {
      if ((this.presenceSockets.get(`${kind}:${userId}`) ?? 0) > 0) {
        present.add(userId);
        continue;
      }
      if (!othersAlive) continue;
      const cached = this.remotePresence.get(`${kind}:${userId}`);
      if (cached && now - cached.at < REMOTE_PRESENCE_CACHE_MS) {
        if (cached.present) present.add(userId);
      } else {
        remote.push(userId);
      }
    }
    if (remote.length === 0) return present;
    const memberLists = await Promise.all(remote.map((userId) => this.redis.zRange(presenceKey(kind, userId), 0, -1)));
    const others = [...new Set(memberLists.flat().map(instanceOf))].filter((id) => id !== this.instanceId);
    const flags = others.length > 0 ? await this.redis.mGet(others.map(instanceKey)) : [];
    const alive = new Set(others.filter((_, i) => flags[i] !== null));
    remote.forEach((userId, i) => {
      const isPresent = memberLists[i]!.some((member) => alive.has(instanceOf(member)));
      if (isPresent) present.add(userId);
      this.cacheRemotePresence(`${kind}:${userId}`, isPresent, now);
    });
    return present;
  }

  /** Remembers a remote presence answer; the oldest entry goes once the cache is full. */
  private cacheRemotePresence(key: string, present: boolean, at: number): void {
    // Re-inserted, so the Map's order stays oldest first
    this.remotePresence.delete(key);
    if (this.remotePresence.size >= REMOTE_PRESENCE_CACHE_MAX) {
      const oldest = this.remotePresence.keys().next().value;
      if (oldest !== undefined) this.remotePresence.delete(oldest);
    }
    this.remotePresence.set(key, { present, at });
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
    // Our own publishes come back to our subscriber too; already delivered
    if (raw.startsWith(this.ownPrefix)) return;
    this.othersSeenAt = Date.now();
    const message = MESSAGE_ENVELOPE.exec(raw);
    if (message && raw.endsWith("}")) {
      let topic: unknown;
      try {
        topic = JSON.parse(message[1]!);
      } catch {
        return;
      }
      if (typeof topic === "string") this.deliverLocal(topic, raw.slice(message[0].length, -1));
      return;
    }
    let parsed: Partial<Envelope> & { topic?: string; message?: object; closeUser?: number; closeTopic?: string; code?: number; reason?: string };
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }
    // Already delivered locally by publish()
    if (parsed.origin === this.instanceId) return;
    if (typeof parsed.closeUser === "number") return this.closeLocal(parsed.closeUser);
    if (typeof parsed.closeTopic === "string") {
      return this.closeTopicLocal(parsed.closeTopic, parsed.code ?? 4003, parsed.reason ?? "Access removed");
    }
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

  private closeTopicLocal(topic: string, code: number, reason: string): void {
    for (const socket of [...(this.local.get(topic) ?? [])]) socket.close(code, reason);
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

  /**
   * Pings every socket (terminating ones that never answered), renews this
   * instance's liveness key and tells the other instances it is alive.
   */
  private async beat(): Promise<void> {
    for (const [socket, entry] of this.attached) {
      if (!entry.alive) {
        socket.terminate();
        continue;
      }
      entry.alive = false;
      socket.ping();
    }
    await Promise.all([
      this.renewLiveness().catch((err) => this.log.error({ err }, "Renewing instance liveness failed")),
      this.announce(),
    ]);
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
