import type { Queryable } from "../db.js";
import { CHAT_OPEN_AFTER_END_MS, type ChatAccess } from "../game/chatText.js";

export interface ChatMessageRow {
  /** bigint: as a string, so it is exact whatever its size */
  id: string;
  senderId: number;
  body: string;
  createdAt: Date;
}

/** Messages one player may write in one game */
export const CHAT_MAX_PER_PLAYER = 100;

/**
 * Data access for game chat. Every value reaches the database as a bound
 * parameter; message text is never part of the SQL.
 */
export const gameChatRepository = {
  /** The players of a live game (not a bot game), what each allows, and whether they are friends. */
  async access(db: Queryable, gameId: number): Promise<ChatAccess | null> {
    const { rows } = await db.query<ChatAccess>(
      `SELECT g."whiteId", g."blackId", g.status, g."endedAt",
         COALESCE(ws."gameChatAllowedFrom", 'everyone') AS "whiteAllows",
         COALESCE(bs."gameChatAllowedFrom", 'everyone') AS "blackAllows",
         EXISTS (
           SELECT 1 FROM friends f
           WHERE LEAST(f."userOneId", f."userTwoId") = LEAST(g."whiteId", g."blackId")
             AND GREATEST(f."userOneId", f."userTwoId") = GREATEST(g."whiteId", g."blackId")
         ) AS "areFriends"
       FROM games g
       LEFT JOIN user_settings ws ON ws."userId" = g."whiteId"
       LEFT JOIN user_settings bs ON bs."userId" = g."blackId"
       WHERE g.id = $1 AND g."botId" IS NULL AND g."whiteId" IS NOT NULL AND g."blackId" IS NOT NULL`,
      [gameId]
    );
    return rows[0] ?? null;
  },

  /**
   * Stores a message if, at this moment, the sender is one of the game's two
   * players, the game is on (or ended only just) and they have messages
   * left. The check and the insert are one statement, so nothing can change
   * between them. Null when it wasn't stored.
   */
  async insert(db: Queryable, gameId: number, senderId: number, body: string): Promise<ChatMessageRow | null> {
    const { rows } = await db.query<ChatMessageRow>(
      `INSERT INTO game_chat_messages ("gameId", "senderId", body)
       SELECT g.id, $2::int, $3
       FROM games g
       WHERE g.id = $1 AND g."botId" IS NULL
         AND $2::int IN (g."whiteId", g."blackId")
         AND (g.status = 'in_progress' OR g."endedAt" > now() - ($4::int * interval '1 millisecond'))
         AND (SELECT count(*) FROM game_chat_messages m
              WHERE m."gameId" = g.id AND m."senderId" = $2::int) < $5::int
       RETURNING id::text AS id, "senderId", body, "createdAt"`,
      [gameId, senderId, body, CHAT_OPEN_AFTER_END_MS, CHAT_MAX_PER_PLAYER]
    );
    return rows[0] ?? null;
  },

  /** The game's latest messages, oldest first. */
  async recent(db: Queryable, gameId: number, limit: number): Promise<ChatMessageRow[]> {
    const { rows } = await db.query<ChatMessageRow>(
      // "m.id": a bare "id" in ORDER BY would be the text alias, and sort "99" after "100"
      `SELECT m.id::text AS id, m."senderId", m.body, m."createdAt"
       FROM game_chat_messages m WHERE m."gameId" = $1 ORDER BY m.id DESC LIMIT $2`,
      [gameId, limit]
    );
    return rows.reverse();
  },

  /** Deletes a batch of messages from games that ended before `before`. Returns how many went. */
  async deleteForGamesEndedBefore(db: Queryable, before: Date, limit: number): Promise<number> {
    const { rowCount } = await db.query(
      `DELETE FROM game_chat_messages WHERE id IN (
         SELECT m.id FROM game_chat_messages m JOIN games g ON g.id = m."gameId"
         WHERE g."endedAt" < $1 LIMIT $2)`,
      [before, limit]
    );
    return rowCount ?? 0;
  },
};
