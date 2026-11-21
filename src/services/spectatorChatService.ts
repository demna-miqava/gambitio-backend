import type { FastifyInstance } from "fastify";
import { AppError } from "../errors/AppError.js";
import { topics, type RealtimeHub } from "../realtime/hub.js";
import { CHAT_MAX_LENGTH, CHAT_OPEN_AFTER_END_MS, cleanChatText } from "../game/chatText.js";
import { withinLimit } from "../utils/rateLimit.js";

/** Messages a late joiner gets with the game state */
export const SPECTATOR_CHAT_HISTORY = 50;
/** One viewer, one game: this many messages per window, on every socket and instance together */
export const SPECTATOR_CHAT_BURST = { max: 5, windowSeconds: 10 };
/** Messages one viewer may write in one game's spectator chat */
export const SPECTATOR_CHAT_MAX_PER_USER = 200;

export interface SpectatorChatMessage {
  id: string;
  userId: number;
  /** As the sender's name was when they wrote */
  username: string;
  text: string;
  /** When it was written, in ms since the epoch */
  at: number;
}

export interface SpectatorChatState {
  enabled: boolean;
  /** "closed": the game ended more than CHAT_OPEN_AFTER_END_MS ago (read only) */
  reason: "closed" | null;
  messages: SpectatorChatMessage[];
  /** When writing closes, once the game has ended (ms since the epoch) */
  closesAt: number | null;
}

interface MessageRow {
  id: string;
  senderId: number;
  username: string;
  body: string;
  createdAt: Date;
}

const toMessage = (row: MessageRow): SpectatorChatMessage => ({
  id: row.id,
  userId: row.senderId,
  username: row.username,
  text: row.body,
  at: row.createdAt.getTime(),
});

/** A game spectator chat can belong to: played live between two accounts */
const CHAT_GAME = `g."botId" IS NULL AND NOT g."tableGame" AND g."whiteId" IS NOT NULL AND g."blackId" IS NOT NULL`;
/** Writing is open while the game is on and for a while after, like the players' chat */
const OPEN = `(g.status = 'in_progress' OR g."endedAt" > now() - ($OPEN_MS::int * interval '1 millisecond'))`;
/** A block either way between two users (columns or parameters) */
const blockedBetween = (a: string, b: string) =>
  `EXISTS (SELECT 1 FROM user_blocks sb
     WHERE (sb."blockerId" = ${a}::int AND sb."blockedId" = ${b}::int)
        OR (sb."blockerId" = ${b}::int AND sb."blockedId" = ${a}::int))`;

/**
 * One shared chat for everyone watching a live game, over the game socket.
 *
 * The game's two players never receive it, while the game is on or after:
 * spectators can run an engine, so a chat the players could read would be
 * a way to pass them moves. That rests on the server alone:
 * - only sockets of people who aren't playing in the game are subscribed to
 *   its topic (topics.spectatorChat; the game socket subscribes once it
 *   knows who the socket's user is, and a game's players never change);
 * - every message is published with both players in its exclude list
 *   (hub.publishExcept), so a player's socket can't get it even if it were
 *   subscribed;
 * - state() returns nothing for a player, so no history reaches them;
 * - players can't write in it (the insert checks).
 *
 * A message is never delivered to anyone with a block either way with its
 * author: they are in the exclude list too, and history leaves their
 * messages out. One publish per message however many people watch: the
 * list travels with it and each instance filters its own sockets.
 *
 * Who writes, and in which game, always comes from the authenticated socket.
 * Text is cleaned like game chat (chatText.ts), only ever bound as a SQL
 * parameter, and sent as JSON for the client to render as text.
 */
export class SpectatorChatService {
  constructor(
    private fastify: FastifyInstance,
    private hub: RealtimeHub
  ) {}

  private query<T extends object>(sql: string, params: unknown[]) {
    // $OPEN_MS becomes the next parameter, bound to CHAT_OPEN_AFTER_END_MS
    return this.fastify.pg.query<T>(sql.replaceAll("$OPEN_MS", () => `$${params.length + 1}`), [
      ...params,
      CHAT_OPEN_AFTER_END_MS,
    ]);
  }

  /**
   * What a viewer sees: whether they can write, the latest messages (none
   * from anyone with a block either way with them) and when writing closes.
   * Null for the game's players, and for games that have no spectator chat
   * (bot and table games).
   */
  async state(gameId: number, viewerId: number): Promise<SpectatorChatState | null> {
    const { rows: games } = await this.query<{ whiteId: number; blackId: number; open: boolean; endedAt: Date | null }>(
      `SELECT g."whiteId", g."blackId", ${OPEN} AS open, g."endedAt"
       FROM games g WHERE g.id = $1 AND ${CHAT_GAME}`,
      [gameId]
    );
    const game = games[0];
    if (!game || viewerId === game.whiteId || viewerId === game.blackId) return null;
    const { rows } = await this.fastify.pg.query<MessageRow>(
      `SELECT c.id::text AS id, c."senderId", u.username, c.body, c."createdAt"
       FROM spectator_chat_messages c JOIN users u ON u.id = c."senderId"
       WHERE c."gameId" = $1
         AND (c."senderId" = $2 OR NOT ${blockedBetween(`c."senderId"`, "$2")})
       ORDER BY c.id DESC LIMIT $3`,
      [gameId, viewerId, SPECTATOR_CHAT_HISTORY]
    );
    return {
      enabled: game.open,
      reason: game.open ? null : "closed",
      messages: rows.reverse().map(toMessage),
      closesAt: game.endedAt ? game.endedAt.getTime() + CHAT_OPEN_AFTER_END_MS : null,
    };
  }

  async send(gameId: number, userId: number, rawText: string): Promise<void> {
    const cleaned = cleanChatText(rawText);
    if (!cleaned.ok) {
      throw cleaned.reason === "empty"
        ? new AppError("Write a message first", "CHAT_EMPTY", 400)
        : new AppError(`Messages can be up to ${CHAT_MAX_LENGTH} characters`, "CHAT_TOO_LONG", 400);
    }
    const allowed = await withinLimit(
      this.fastify.redis,
      `spectator-chat:burst:${gameId}:${userId}`,
      SPECTATOR_CHAT_BURST.max,
      SPECTATOR_CHAT_BURST.windowSeconds
    );
    if (!allowed) throw new AppError("You're sending messages too fast. Wait a moment.", "CHAT_RATE_LIMITED", 429);

    // The game having spectator chat, the sender not playing in it, the chat
    // being open and the sender's message count, in the insert itself
    const { rows } = await this.query<MessageRow & { whiteId: number; blackId: number }>(
      `WITH g AS (
         SELECT g.id, g."whiteId", g."blackId" FROM games g
         WHERE g.id = $1 AND ${CHAT_GAME}
           AND $2::int NOT IN (g."whiteId", g."blackId")
           AND ${OPEN}
           AND (SELECT count(*) FROM spectator_chat_messages c
                WHERE c."gameId" = g.id AND c."senderId" = $2::int) < $4::int
       ), inserted AS (
         INSERT INTO spectator_chat_messages ("gameId", "senderId", body)
         SELECT g.id, $2::int, $3 FROM g
         RETURNING id, "senderId", body, "createdAt"
       )
       SELECT i.id::text AS id, i."senderId", u.username, i.body, i."createdAt", g."whiteId", g."blackId"
       FROM inserted i, g, users u WHERE u.id = i."senderId"`,
      [gameId, userId, cleaned.text, SPECTATOR_CHAT_MAX_PER_USER]
    );
    const row = rows[0];
    if (!row) throw await this.refusal(gameId, userId);

    // Everyone with a block either way with the sender, on any instance
    const { rows: blocked } = await this.fastify.pg.query<{ id: number }>(
      `SELECT "blockedId" AS id FROM user_blocks WHERE "blockerId" = $1
       UNION
       SELECT "blockerId" FROM user_blocks WHERE "blockedId" = $1`,
      [userId]
    );
    await this.hub.publishExcept(
      topics.spectatorChat(gameId),
      { type: "spectator_chat", data: toMessage(row) },
      // The players first: never delivered to either of them
      [row.whiteId, row.blackId, ...blocked.map((b) => b.id)]
    );
  }

  /** Why a message wasn't stored (rare, so the insert doesn't pay for it). */
  private async refusal(gameId: number, userId: number): Promise<AppError> {
    const { rows } = await this.query<{ chat: boolean; player: boolean; open: boolean }>(
      `SELECT ${CHAT_GAME} AS chat, $2::int IN (g."whiteId", g."blackId") AS player, ${OPEN} AS open
       FROM games g WHERE g.id = $1`,
      [gameId, userId]
    );
    const game = rows[0];
    if (!game) return new AppError("Game not found", "GAME_NOT_FOUND", 404);
    if (!game.chat) return new AppError("This game has no spectator chat", "CHAT_UNAVAILABLE", 400);
    if (game.player) return new AppError("Players can't use the spectator chat", "NOT_A_SPECTATOR", 403);
    if (!game.open) return new AppError("This chat has closed", "CHAT_CLOSED", 403);
    return new AppError(
      `You can send up to ${SPECTATOR_CHAT_MAX_PER_USER} messages in one game`,
      "CHAT_LIMIT_REACHED",
      429
    );
  }

  /**
   * Whether `reporterId` can report `reportedId` from this game's spectator
   * chat (ModerationService.report): the reporter isn't playing in the game
   * and the reported user has written in its spectator chat.
   */
  async canReportFrom(gameId: number, reporterId: number, reportedId: number): Promise<boolean> {
    const { rows } = await this.fastify.pg.query(
      `SELECT 1 FROM games g
       WHERE g.id = $1 AND ${CHAT_GAME} AND $2::int NOT IN (g."whiteId", g."blackId")
         AND EXISTS (SELECT 1 FROM spectator_chat_messages c WHERE c."gameId" = g.id AND c."senderId" = $3)`,
      [gameId, reporterId, reportedId]
    );
    return rows.length > 0;
  }

  /** Deletes messages of games that ended before `before`, a batch at a time (game chat's schedule). */
  async sweep(before: Date, batch = 1_000): Promise<void> {
    for (;;) {
      const { rowCount } = await this.fastify.pg.query(
        `DELETE FROM spectator_chat_messages WHERE id IN (
           SELECT c.id FROM spectator_chat_messages c JOIN games g ON g.id = c."gameId"
           WHERE g."endedAt" < $1 LIMIT $2)`,
        [before, batch]
      );
      if ((rowCount ?? 0) < batch) return;
    }
  }
}
