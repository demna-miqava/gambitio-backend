import type { FastifyInstance } from "fastify";
import { AppError } from "../errors/AppError.js";
import { topics, type RealtimeHub } from "../realtime/hub.js";
import { friendsUpdatedMessage } from "./friendService.js";
import { withinLimit } from "../utils/rateLimit.js";
import { stripInvisibleText } from "../game/chatText.js";

/** Same values as the CHECK in migrations/028_blocks_and_reports.sql */
export const REPORT_REASONS = ["cheating", "abusive_chat", "unsporting", "offensive_name", "other"] as const;
export type ReportReason = (typeof REPORT_REASONS)[number];

export const REPORT_DETAILS_MAX_LENGTH = 1000;

/**
 * Report details as stored: invisible and control characters removed as in
 * chat (terminal escape sequences included: reports are read in a terminal,
 * scripts/reports.ts), line breaks kept (at most one blank line in a row),
 * other whitespace runs made one space, trimmed. Null when nothing is left.
 */
export function cleanReportDetails(raw: string | undefined): string | null {
  if (raw === undefined) return null;
  const text = stripInvisibleText(raw)
    .replace(/\r\n?|[\u000B\u000C\u2028\u2029]/g, "\n")
    .replace(/[^\S\n]+/gu, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (!text) return null;
  // Normalising can lengthen a few characters; the column counts code points
  const chars = [...text];
  return chars.length > REPORT_DETAILS_MAX_LENGTH ? chars.slice(0, REPORT_DETAILS_MAX_LENGTH).join("").trim() : text;
}

/**
 * Text written by players, made safe to print in a terminal: control and
 * invisible characters (which could move the cursor, rewrite earlier lines,
 * change colours or reorder what is shown) are printed as \u{...} escapes.
 * Line breaks stay when `multiline` is set. Reports are cleaned when they
 * are stored; this also covers rows stored before that, and chat excerpts.
 */
export function escapeForTerminal(text: string, { multiline = false } = {}): string {
  return text.replace(
    /[\u0000-\u001F\u007F-\u009F\u00AD\u061C\u180E\u200B\u200E\u200F\u2028-\u202E\u2060-\u206F\uFEFF\uFFF9-\uFFFB\uD800-\uDFFF]|[\u{E0000}-\u{E007F}]/gu,
    (char) =>
      multiline && char === "\n" ? char : `\\u{${char.codePointAt(0)!.toString(16).toUpperCase()}}`
  );
}

/** Most players one account can have blocked */
const MAX_BLOCKS = 500;
/** Reports one account can file per day, so the queue can't be flooded */
const REPORTS_PER_DAY = { max: 20, windowSeconds: 24 * 60 * 60 };
/** A second report of the same player within this long is refused */
const REPEAT_REPORT_HOURS = 24;
/** Chat messages kept with a report */
const CHAT_EXCERPT_LIMIT = 200;

export interface BlockedUser {
  id: number;
  username: string;
  avatarUrl: string | null;
  blockedAt: Date;
}

/**
 * Blocking and reporting players (migration 028).
 *
 * Who is blocking or reporting always comes from the authenticated request,
 * never from its body.
 */
export class ModerationService {
  constructor(
    private fastify: FastifyInstance,
    private hub: RealtimeHub
  ) {}

  /** The players a user has blocked, most recent first. */
  async listBlocked(userId: number): Promise<BlockedUser[]> {
    const { rows } = await this.fastify.pg.query<BlockedUser>(
      `SELECT u.id, u.username, u."avatarUrl", b."createdAt" AS "blockedAt"
       FROM user_blocks b JOIN users u ON u.id = b."blockedId"
       WHERE b."blockerId" = $1
       ORDER BY b."createdAt" DESC, u.id`,
      [userId]
    );
    return rows;
  }

  /**
   * Blocks a player. Also ends their friendship and withdraws the friend
   * requests and challenges between the two, in the same transaction, so
   * nothing from before the block is left to answer. Blocking someone who
   * is already blocked changes nothing.
   */
  async block(blockerId: number, blockedId: number): Promise<void> {
    if (blockerId === blockedId) throw new AppError("You can't block yourself", "SELF_BLOCK", 400);

    const dropped = await this.fastify.pg.transact(async (tx) => {
      const { rows: target } = await tx.query(
        `SELECT 1 FROM users WHERE id = $1 AND "clerkId" IS NOT NULL -- not a deleted account`,
        [blockedId]
      );
      if (target.length === 0) throw new AppError("User not found", "USER_NOT_FOUND", 404);

      // The count and the insert are one statement, so two requests at once
      // can't both slip under the limit
      const { rows: inserted } = await tx.query(
        `INSERT INTO user_blocks ("blockerId", "blockedId")
         SELECT $1, $2
         WHERE (SELECT COUNT(*) FROM user_blocks WHERE "blockerId" = $1) < $3
            OR EXISTS (SELECT 1 FROM user_blocks WHERE "blockerId" = $1 AND "blockedId" = $2)
         ON CONFLICT DO NOTHING
         RETURNING 1`,
        [blockerId, blockedId, MAX_BLOCKS]
      );
      if (inserted.length === 0) {
        const { rows: existing } = await tx.query(
          `SELECT 1 FROM user_blocks WHERE "blockerId" = $1 AND "blockedId" = $2`,
          [blockerId, blockedId]
        );
        if (existing.length === 0) {
          throw new AppError(
            `You can block up to ${MAX_BLOCKS} players. Unblock someone first.`,
            "BLOCK_LIMIT_REACHED",
            409
          );
        }
      }

      const { rowCount: friendships } = await tx.query(
        `DELETE FROM friends
         WHERE ("userOneId" = $1 AND "userTwoId" = $2) OR ("userOneId" = $2 AND "userTwoId" = $1)`,
        [blockerId, blockedId]
      );
      const { rows: requests } = await tx.query<{ senderId: number }>(
        `DELETE FROM friend_requests
         WHERE ("senderId" = $1 AND "receiverId" = $2) OR ("senderId" = $2 AND "receiverId" = $1)
         RETURNING "senderId"`,
        [blockerId, blockedId]
      );
      const { rows: challenges } = await tx.query<{ challengerId: number; challengedId: number }>(
        `DELETE FROM challenges
         WHERE ("challengerId" = $1 AND "challengedId" = $2) OR ("challengerId" = $2 AND "challengedId" = $1)
         RETURNING "challengerId", "challengedId"`,
        [blockerId, blockedId]
      );
      // Table games waiting for one of them to confirm: declined, so the
      // game stays the recorder's alone (src/services/tableGameService.ts)
      await tx.query(
        `UPDATE table_game_requests SET status = 'declined'
         WHERE status = 'pending'
           AND (("recorderId" = $1 AND "friendId" = $2) OR ("recorderId" = $2 AND "friendId" = $1))`,
        [blockerId, blockedId]
      );
      return { wereFriends: (friendships ?? 0) > 0, requests, challenges };
    });

    // What the blocked player sees is what they would see had the blocker
    // unfriended them, declined or withdrawn: nothing says "blocked"
    const tell = (userId: number, message: object) =>
      this.hub
        .publish(topics.notifications(userId), message)
        .catch((err) => this.fastify.log.error({ err, userId }, "Failed to publish after a block"));
    if (dropped.wereFriends) {
      await tell(blockedId, friendsUpdatedMessage("removed", { id: blockerId }));
    }
    for (const { senderId } of dropped.requests) {
      await tell(
        blockedId,
        friendsUpdatedMessage(senderId === blockedId ? "request_declined" : "request_cancelled", {
          id: blockerId,
        })
      );
    }
    for (const { challengerId, challengedId } of dropped.challenges) {
      await tell(challengedId, { type: "challenge_cancelled", data: { challengerId } });
      // "expired": the sender's waiting state clears without naming a decline
      await tell(challengerId, { type: "challenge_declined", data: { challengedId, reason: "expired" } });
    }
    await this.changed(blockerId);
  }

  /** Unblocking someone who isn't blocked changes nothing. */
  async unblock(blockerId: number, blockedId: number): Promise<void> {
    const { rowCount } = await this.fastify.pg.query(
      `DELETE FROM user_blocks WHERE "blockerId" = $1 AND "blockedId" = $2`,
      [blockerId, blockedId]
    );
    if (rowCount) await this.changed(blockerId);
  }

  /**
   * After a block or unblock: the blocker's other tabs reload their lists,
   * and a game the two are playing opens or closes its chat for both.
   */
  private async changed(blockerId: number): Promise<void> {
    await this.hub
      .publish(topics.notifications(blockerId), { type: "blocks_updated", data: {} })
      .catch((err) => this.fastify.log.error({ err }, "Failed to publish a block change"));
    await this.fastify.gameChat
      .announceStatus(blockerId)
      .catch((err) => this.fastify.log.error({ err }, "Failed to announce chat status after a block"));
  }

  /**
   * Files a report. With a game, both players must have played in it, and
   * its chat is copied onto the report (chat is deleted an hour after the
   * game). With a study room instead (migration 041), the reporter must be
   * in it (and not kept out of it as a player of its live game), and the
   * reported player must be in it too or have written in its chat, which
   * is copied the same way. One player can be reported once a day by the
   * same account.
   */
  async report(
    reporterId: number,
    input: {
      reportedId: number;
      reason: ReportReason;
      details?: string | undefined;
      gameId?: number | undefined;
      studyRoomId?: number | undefined;
    }
  ): Promise<{ id: number }> {
    const { reportedId, reason, gameId, studyRoomId } = input;
    if (gameId !== undefined && studyRoomId !== undefined) {
      throw new AppError("A report is about a game or a study room, not both", "INVALID_REPORT", 400);
    }
    if (reporterId === reportedId) throw new AppError("You can't report yourself", "SELF_REPORT", 400);
    const details = cleanReportDetails(input.details);

    const { rows: target } = await this.fastify.pg.query(
      `SELECT 1 FROM users WHERE id = $1 AND "clerkId" IS NOT NULL -- not a deleted account`,
      [reportedId]
    );
    if (target.length === 0) throw new AppError("User not found", "USER_NOT_FOUND", 404);

    if (gameId !== undefined) {
      const { rows: game } = await this.fastify.pg.query(
        `SELECT 1 FROM games
         WHERE id = $1 AND (("whiteId" = $2 AND "blackId" = $3) OR ("whiteId" = $3 AND "blackId" = $2))
           -- Table games (migration 040) have no chat or play online to report
           AND NOT "tableGame"`,
        [gameId, reporterId, reportedId]
      );
      if (game.length === 0) {
        throw new AppError("That isn't a game between you and this player", "NOT_YOUR_GAME", 400);
      }
    }

    if (studyRoomId !== undefined && !(await this.fastify.study.canReportFrom(studyRoomId, reporterId, reportedId))) {
      throw new AppError("That isn't a study room you share with this player", "NOT_YOUR_ROOM", 400);
    }

    const { rows: recent } = await this.fastify.pg.query(
      `SELECT 1 FROM user_reports
       WHERE "reporterId" = $1 AND "reportedId" = $2
         AND "createdAt" > now() - make_interval(hours => $3)
       LIMIT 1`,
      [reporterId, reportedId, REPEAT_REPORT_HOURS]
    );
    if (recent.length > 0) {
      throw new AppError(
        "You've already reported this player. We'll look into it.",
        "ALREADY_REPORTED",
        409
      );
    }
    const allowed = await withinLimit(
      this.fastify.redis,
      `reports:${reporterId}`,
      REPORTS_PER_DAY.max,
      REPORTS_PER_DAY.windowSeconds
    );
    if (!allowed) {
      throw new AppError("You've sent a lot of reports today. Try again tomorrow.", "REPORT_RATE_LIMITED", 429);
    }

    const { rows } = await this.fastify.pg.query<{ id: number }>(
      // The latest messages of the game's chat, or of the room's (at most one is given)
      `INSERT INTO user_reports ("reporterId", "reportedId", reason, details, "gameId", "studyRoomId", "chatExcerpt")
       VALUES ($1, $2, $3, $4, $5::int, $7::int, COALESCE(
         (SELECT jsonb_agg(jsonb_build_object('userId', m."senderId", 'text', m.body, 'at', m."createdAt")
                           ORDER BY m.id)
          FROM (SELECT id, "senderId", body, "createdAt" FROM game_chat_messages
                WHERE "gameId" = $5::int ORDER BY id DESC LIMIT $6) m),
         (SELECT jsonb_agg(jsonb_build_object('userId', m."senderId", 'text', m.body, 'at', m."createdAt")
                           ORDER BY m.id)
          FROM (SELECT id, "senderId", body, "createdAt" FROM study_chat_messages
                WHERE "roomId" = $7::int ORDER BY id DESC LIMIT $6) m)))
       RETURNING id`,
      [reporterId, reportedId, reason, details, gameId ?? null, CHAT_EXCERPT_LIMIT, studyRoomId ?? null]
    );
    return { id: rows[0]!.id };
  }
}
