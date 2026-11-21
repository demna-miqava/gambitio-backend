import type { FastifyInstance } from "fastify";
import { AppError } from "../errors/AppError.js";
import { topics, type RealtimeHub } from "../realtime/hub.js";
import { CHAT_MAX_LENGTH, chatOffReason, cleanChatText, type ChatOffReason } from "../game/chatText.js";
import { CHAT_MAX_PER_PLAYER, gameChatRepository, type ChatMessageRow } from "../repositories/gameChatRepository.js";
import { gameRepository } from "../repositories/gameRepository.js";
import { withinLimit } from "../utils/rateLimit.js";

/** Messages sent with the game state when a player (re)connects */
const HISTORY_LIMIT = 50;
/** One player, one game: this many messages per window, on every socket and instance together */
const BURST = { max: 5, windowSeconds: 10 };
/**
 * Messages are deleted this long after their game ended. Nothing shows chat
 * once players leave the game page, so they are kept only past the window in
 * which chat stays open, for a reload in those last minutes. Counted from the
 * game's end rather than when they were written, so a long game never loses
 * its messages while it is being played.
 */
export const RETENTION_AFTER_END_MS = 60 * 60_000;
const SWEEP_BATCH = 1_000;

const OFF_MESSAGES: Record<ChatOffReason, string> = {
  off_by_you: "Chat is turned off in your settings",
  off_by_opponent: "Your opponent has chat turned off",
  blocked: "You've blocked this player",
  closed: "This chat has closed",
};

export interface ChatMessage {
  id: string;
  userId: number;
  text: string;
  /** When it was written, in ms since the epoch */
  at: number;
}

const toMessage = (row: ChatMessageRow): ChatMessage => ({
  id: row.id,
  userId: row.senderId,
  text: row.body,
  at: row.createdAt.getTime(),
});

/**
 * Chat between the two players of a live game. Spectators neither see nor
 * send it: messages go out on each player's own topic for the game, never
 * on the game's topic.
 *
 * Who is writing and in which game always come from the authenticated
 * socket, never from the message.
 */
export class GameChatService {
  constructor(
    private fastify: FastifyInstance,
    private hub: RealtimeHub
  ) {}

  /**
   * What a player sees when they open the game: whether they can write, why
   * not, and the latest messages. Null for anyone who isn't playing in it.
   */
  async state(
    gameId: number,
    viewerId: number
  ): Promise<{ enabled: boolean; reason: ChatOffReason | null; messages: ChatMessage[] } | null> {
    const access = await gameChatRepository.access(this.fastify.pg, gameId);
    if (!access || (viewerId !== access.whiteId && viewerId !== access.blackId)) return null;
    const reason = chatOffReason(access, viewerId, Date.now());
    // With chat off by a setting or a block, earlier messages stay hidden too
    const hidden = reason === "off_by_you" || reason === "off_by_opponent" || reason === "blocked";
    const rows = hidden ? [] : await gameChatRepository.recent(this.fastify.pg, gameId, HISTORY_LIMIT);
    return { enabled: reason === null, reason, messages: rows.map(toMessage) };
  }

  async send(gameId: number, userId: number, rawText: string): Promise<void> {
    const cleaned = cleanChatText(rawText);
    if (!cleaned.ok) {
      throw cleaned.reason === "empty"
        ? new AppError("Write a message first", "CHAT_EMPTY", 400)
        : new AppError(`Messages can be up to ${CHAT_MAX_LENGTH} characters`, "CHAT_TOO_LONG", 400);
    }

    const access = await gameChatRepository.access(this.fastify.pg, gameId);
    if (!access) throw new AppError("Game not found", "GAME_NOT_FOUND", 404);
    if (userId !== access.whiteId && userId !== access.blackId) {
      throw new AppError("Only the players can chat in this game", "NOT_A_PLAYER", 403);
    }
    const reason = chatOffReason(access, userId, Date.now());
    if (reason) {
      throw new AppError(OFF_MESSAGES[reason], reason === "closed" ? "CHAT_CLOSED" : "CHAT_DISABLED", 403);
    }

    const allowed = await withinLimit(
      this.fastify.redis,
      `chat:burst:${gameId}:${userId}`,
      BURST.max,
      BURST.windowSeconds
    );
    if (!allowed) {
      throw new AppError("You're sending messages too fast. Wait a moment.", "CHAT_RATE_LIMITED", 429);
    }

    const row = await gameChatRepository.insert(this.fastify.pg, gameId, userId, cleaned.text);
    if (!row) {
      // The checks above passed, so either the game's chat just closed or
      // this player has used up their messages
      throw new AppError(
        `You can send up to ${CHAT_MAX_PER_PLAYER} messages in one game`,
        "CHAT_LIMIT_REACHED",
        429
      );
    }

    const message = { type: "chat", data: toMessage(row) };
    // The sender's copy is their confirmation, and keeps their other tabs in step
    await this.hub.publish(topics.gameUser(gameId, access.whiteId), message);
    await this.hub.publish(topics.gameUser(gameId, access.blackId), message);
  }

  /**
   * A player changed who they chat with (a setting, a block or an unblock):
   * if they are in a game, both players are told at once how its chat stands for them now ("chat_status", the
   * same shape as the chat part of the game state), so the opponent sees
   * that chat was turned off, or back on, without reloading.
   */
  async announceStatus(userId: number): Promise<void> {
    const gameId = await gameRepository.findActiveGameIdForUser(this.fastify.pg, userId);
    if (gameId === null) return;
    const access = await gameChatRepository.access(this.fastify.pg, gameId);
    if (!access) return;
    for (const playerId of [access.whiteId, access.blackId]) {
      const data = await this.state(gameId, playerId);
      if (data) await this.hub.publish(topics.gameUser(gameId, playerId), { type: "chat_status", data });
    }
  }

  /**
   * Deletes messages past their retention, a batch at a time: game chat, the
   * chat of study rooms watching a game, and spectator chat (same schedule).
   */
  async sweep(now = new Date()): Promise<void> {
    const before = new Date(now.getTime() - RETENTION_AFTER_END_MS);
    while (
      (await gameChatRepository.deleteForGamesEndedBefore(this.fastify.pg, before, SWEEP_BATCH)) === SWEEP_BATCH
    );
    await this.fastify.study.sweepChat(before, SWEEP_BATCH);
    await this.fastify.spectatorChat.sweep(before, SWEEP_BATCH);
  }
}
