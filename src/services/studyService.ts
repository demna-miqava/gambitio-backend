import type { FastifyInstance } from "fastify";
import type { Queryable } from "../db.js";
import { AppError } from "../errors/AppError.js";
import { topics, type RealtimeHub } from "../realtime/hub.js";
import {
  applyStudyOp,
  createStudyState,
  nodeCount,
  ROOT_ID,
  storedStudyDocument,
  syncGameLine,
  type StudyChange,
  type StudyOp,
  type StudyState,
} from "../game/studyState.js";
import { withinLimit } from "../utils/rateLimit.js";
import { loadGame } from "../game/engine.js";
import { CHAT_MAX_LENGTH, CHAT_OPEN_AFTER_END_MS, cleanChatText } from "../game/chatText.js";

/** Rooms one player may own. */
export const MAX_ROOMS_PER_OWNER = 30;
/** People in one room, the owner included. */
export const MAX_ROOM_MEMBERS = 20;

/** Room chat (rooms linked to a game): messages one member may write in one room */
export const STUDY_CHAT_MAX_PER_MEMBER = 200;
/** One member, one room: this many messages per window, on every socket and instance together */
export const STUDY_CHAT_BURST = { max: 5, windowSeconds: 10 };
/** Room chat history sent with the room */
const CHAT_HISTORY_LIMIT = 50;

/**
 * Fair play for rooms linked to a game: true (in SQL) unless `user` is one
 * of the players of the room's game while it is in progress. Such a player
 * can't create, join, be invited to, read or open the room; for them it
 * doesn't exist. `room` is an alias of study_rooms, `user` a parameter.
 */
const notLivePlayer = (room: string, user: string) =>
  `NOT EXISTS (SELECT 1 FROM games lg WHERE lg.id = ${room}."gameId" AND lg.status = 'in_progress'
     AND ${user}::int IN (lg."whiteId", lg."blackId"))`;
/** A member who isn't kept out by notLivePlayer */
const memberSql = (room: string, user: string) =>
  `EXISTS (SELECT 1 FROM study_room_members mm WHERE mm."roomId" = ${room}.id AND mm."userId" = ${user}::int)
   AND ${notLivePlayer(room, user)}`;

/** `user`'s game-chat setting ("gameChatAllowedFrom"), in SQL; `user` is a column or a parameter */
const chatSetting = (user: string) =>
  `COALESCE((SELECT cs."gameChatAllowedFrom" FROM user_settings cs WHERE cs."userId" = ${user}::int), 'everyone')`;
/** Whether `user`'s setting lets `other` chat with them: game chat's rule (allows in src/game/chatText.ts) */
const chatSettingAllows = (user: string, other: string) =>
  `CASE ${chatSetting(user)}
     WHEN 'everyone' THEN true
     WHEN 'only_friends' THEN EXISTS (SELECT 1 FROM friends cf
       WHERE LEAST(cf."userOneId", cf."userTwoId") = LEAST(${user}::int, ${other}::int)
         AND GREATEST(cf."userOneId", cf."userTwoId") = GREATEST(${user}::int, ${other}::int))
     ELSE false END`;
/**
 * Room chat between two members, as game chat has it between two players:
 * no block either way, and each one's game-chat setting allows the other.
 * A member whose setting is "nobody" gets no room chat at all.
 */
const roomChatBetween = (a: string, b: string) =>
  `NOT EXISTS (SELECT 1 FROM user_blocks cb
     WHERE (cb."blockerId" = ${a}::int AND cb."blockedId" = ${b}::int)
        OR (cb."blockerId" = ${b}::int AND cb."blockedId" = ${a}::int))
   AND ${chatSettingAllows(a, b)} AND ${chatSettingAllows(b, a)}`;

/** Why a member can't write in a room's chat: their own setting is "nobody", or it closed after the game */
export type StudyChatOffReason = "off_by_you" | "closed";

export interface StudyChatMessage {
  id: string;
  userId: number;
  text: string;
  /** When it was written, in ms since the epoch */
  at: number;
}

/** Redis set of the sockets open on a room; see RealtimeHub.addMembership. */
export const studyPresenceKey = (roomId: number) => `presence:study:${roomId}`;

/**
 * Changes that rewrite the stored document (new moves, comments, arrows,
 * deletes, promotions) one player may make to one room, over all their
 * sockets and every server instance. Enough to enter a known opening at
 * speed. Moving around the tree (goto, or a move the tree already has)
 * isn't counted here: it is one small UPDATE (see apply), and each socket's
 * own limit (a burst of 20, then 10 a second, see socket.ts) already caps
 * it, so holding an arrow key down keeps working.
 */
export const STUDY_WRITE_LIMIT = { max: 40, windowSeconds: 10 };

/**
 * A linked room whose tree couldn't take the game's line (it is full): the
 * room's version then, and the reason. Until the room changes, sync_game
 * answers with the reason without replaying the game under the row lock;
 * after a change, one member's retry counts against STUDY_WRITE_LIMIT.
 */
const gameSyncRefusedKey = (roomId: number) => `study:gamesync:refused:${roomId}`;
const GAME_SYNC_REFUSED_TTL_SECONDS = 6 * 60 * 60;

/**
 * The cursor to use with a stored document. The column can name a node
 * that is no longer there: code from before migration 031 (still running
 * during a deploy) writes only the document, cursor included, and may have
 * deleted that node. Then the document's own cursor is used if it is in the
 * tree, else the root.
 */
function cursorIn(state: StudyState, column: string): string {
  if (Object.hasOwn(state.nodes, column)) return column;
  const stored = (state as Partial<StudyState>).cursor;
  return typeof stored === "string" && Object.hasOwn(state.nodes, stored) ? stored : ROOT_ID;
}

export interface StudyMember {
  id: number;
  username: string;
  avatarUrl: string | null;
}

export interface StudyRoomMeta {
  id: number;
  name: string;
  ownerId: number;
  /** The game the room watches (migration 038), null for an ordinary room */
  gameId: number | null;
  createdAt: Date;
  updatedAt: Date;
  version: number;
}

export interface StudyRoomListItem extends Omit<StudyRoomMeta, "version"> {
  ownerUsername: string;
  memberCount: number;
  moveCount: number;
}

const toChatMessage = (row: { id: string; senderId: number; body: string; createdAt: Date }): StudyChatMessage => ({
  id: row.id,
  userId: row.senderId,
  text: row.body,
  at: row.createdAt.getTime(),
});

const roomNotFound = () => new AppError("Study room not found", "STUDY_NOT_FOUND", 404);
const positionGone = () => new AppError("That position is no longer in the study", "INVALID_STUDY_ACTION", 400);
// Same code as the socket's own limit, which the client already handles
const tooFast = () => new AppError("Too many changes at once. Wait a moment.", "RATE_LIMITED", 429);
const notOwner = () => new AppError("Only the room's owner can do that", "NOT_STUDY_OWNER", 403);
const notLinked = () => new AppError("This room isn't linked to a game", "STUDY_NOT_LINKED", 400);
const META = `id, name, "ownerId", "gameId", "createdAt", "updatedAt", version`;

/**
 * Shared study rooms. Every change to a room's analysis (the cursor
 * included) holds the room's row lock and bumps its version; messages go
 * out only after it commits. Only members can see or change a room.
 */
export class StudyService {
  constructor(
    private fastify: FastifyInstance,
    private hub: RealtimeHub
  ) {}

  /** A member, and not a player of the room's game while it is being played (see notLivePlayer). */
  private async isMember(db: Queryable, roomId: number, userId: number) {
    const { rows } = await db.query(`SELECT 1 FROM study_rooms r WHERE r.id = $1 AND ${memberSql("r", "$2")}`, [
      roomId,
      userId,
    ]);
    return rows.length > 0;
  }

  async assertMember(roomId: number, userId: number): Promise<void> {
    if (!(await this.isMember(this.fastify.pg, roomId, userId))) throw roomNotFound();
  }

  async members(roomId: number): Promise<StudyMember[]> {
    const { rows } = await this.fastify.pg.query<StudyMember>(
      `SELECT u.id, u.username, u."avatarUrl" FROM study_room_members m
       JOIN users u ON u.id = m."userId"
       WHERE m."roomId" = $1 ORDER BY m."joinedAt"`,
      [roomId]
    );
    return rows;
  }

  async list(userId: number): Promise<StudyRoomListItem[]> {
    // "nodeCount" is kept with the document, so the documents aren't read here
    const { rows } = await this.fastify.pg.query<
      Omit<StudyRoomListItem, "moveCount" | "memberCount"> & { memberCount: string; nodeCount: number }
    >(
      `SELECT r.id, r.name, r."ownerId", r."gameId", r."createdAt", r."updatedAt", o.username AS "ownerUsername",
         (SELECT COUNT(*) FROM study_room_members c WHERE c."roomId" = r.id) AS "memberCount",
         r."nodeCount"
       FROM study_room_members m
       JOIN study_rooms r ON r.id = m."roomId"
       JOIN users o ON o.id = r."ownerId"
       WHERE m."userId" = $1 AND ${notLivePlayer("r", "$1")}
       ORDER BY r."updatedAt" DESC
       LIMIT 100`,
      [userId]
    );
    return rows.map(({ memberCount, nodeCount, ...room }) => ({
      ...room,
      memberCount: Number(memberCount),
      moveCount: Math.max(0, nodeCount - 1),
    }));
  }

  /**
   * A new room. With `gameId` it watches that live game (Watch together):
   * it starts from the game's moves as they stand, and its main line
   * follows the game (sync_game). Only someone who isn't playing in the
   * game can open one; it counts toward the owner's room limit like any
   * other.
   */
  async create(
    ownerId: number,
    input: { name: string; fen?: string | undefined; moves?: string[] | undefined; gameId?: number | undefined }
  ): Promise<StudyRoomMeta> {
    const linked = input.gameId !== undefined;
    let state = createStudyState(linked ? {} : { fen: input.fen, moves: input.moves });
    return this.fastify.pg.transact(async (tx) => {
      // Serialises room creation per owner, so the limit holds
      await tx.query(`SELECT 1 FROM users WHERE id = $1 FOR UPDATE`, [ownerId]);
      if (linked) {
        const { rows: games } = await tx.query<{
          status: string;
          whiteId: number | null;
          blackId: number | null;
          pgn: string | null;
        }>(`SELECT status, "whiteId", "blackId", pgn FROM games WHERE id = $1 AND "botId" IS NULL`, [input.gameId]);
        const game = games[0];
        if (!game || game.whiteId === null || game.blackId === null) {
          throw new AppError("Game not found", "GAME_NOT_FOUND", 404);
        }
        if (game.status !== "in_progress") {
          throw new AppError("That game has ended. Open it in a study room from its review instead.", "GAME_NOT_LIVE", 409);
        }
        if (ownerId === game.whiteId || ownerId === game.blackId) {
          throw new AppError("You can't watch your own game while it is being played", "GAME_PLAYER", 403);
        }
        state = syncGameLine(state, loadGame(game.pgn).history(), false).state;
      }
      const { rows: count } = await tx.query<{ n: string }>(
        `SELECT COUNT(*) AS n FROM study_rooms WHERE "ownerId" = $1`,
        [ownerId]
      );
      if (Number(count[0]!.n) >= MAX_ROOMS_PER_OWNER) {
        throw new AppError(
          `You can own up to ${MAX_ROOMS_PER_OWNER} study rooms. Delete one first.`,
          "TOO_MANY_ROOMS",
          409
        );
      }
      const { rows } = await tx.query<StudyRoomMeta>(
        `INSERT INTO study_rooms ("ownerId", name, state, cursor, "nodeCount", "gameId")
         VALUES ($1, $2, $3::jsonb, $4, $5, $6)
         RETURNING ${META}`,
        [ownerId, input.name.trim(), storedStudyDocument(state), state.cursor, nodeCount(state), input.gameId ?? null]
      );
      const room = rows[0]!;
      await tx.query(`INSERT INTO study_room_members ("roomId", "userId") VALUES ($1, $2)`, [room.id, ownerId]);
      return room;
    });
  }

  /** Room, analysis and members, for a member. */
  async get(roomId: number, userId: number) {
    await this.assertMember(roomId, userId);
    const { rows } = await this.fastify.pg.query<StudyRoomMeta & { state: StudyState; cursor: string }>(
      `SELECT ${META}, state, cursor FROM study_rooms WHERE id = $1`,
      [roomId]
    );
    const row = rows[0];
    if (!row) throw roomNotFound();
    const { state, cursor, ...room } = row;
    const chat = room.gameId === null ? null : await this.chatState(roomId, room.gameId, userId);
    // Sent as one document, as before the cursor had its own column
    return {
      room,
      state: { ...state, cursor: cursorIn(state, cursor) },
      members: await this.members(roomId),
      ...(chat && { chat }),
    };
  }

  async rename(roomId: number, userId: number, name: string): Promise<StudyRoomMeta> {
    const { rows } = await this.fastify.pg.query<StudyRoomMeta>(
      `UPDATE study_rooms SET name = $3, "updatedAt" = now()
       WHERE id = $1 AND "ownerId" = $2
       RETURNING ${META}`,
      [roomId, userId, name.trim()]
    );
    if (!rows[0]) {
      await this.assertMember(roomId, userId);
      throw notOwner();
    }
    await this.publish(roomId, { type: "room_renamed", name: rows[0].name });
    return rows[0];
  }

  async remove(roomId: number, userId: number): Promise<void> {
    const { rowCount } = await this.fastify.pg.query(
      `DELETE FROM study_rooms WHERE id = $1 AND "ownerId" = $2`,
      [roomId, userId]
    );
    if (!rowCount) {
      await this.assertMember(roomId, userId);
      throw notOwner();
    }
    await this.publish(roomId, { type: "room_deleted" });
    await this.closeRoomSockets(roomId);
  }

  /** Closes every socket open on deleted rooms, so they stop listening. Never throws. */
  async closeRoomSockets(roomId: number): Promise<void> {
    await this.hub
      .closeTopicSockets(topics.study(roomId), 4004, "Room deleted")
      .catch((err) => this.fastify.log.error({ err, roomId }, "Failed to close study sockets"));
  }

  /** Any member may invite one of their friends. */
  async invite(roomId: number, inviter: { id: number; username: string }, inviteeId: number): Promise<StudyMember[]> {
    const name = await this.fastify.pg.transact(async (tx) => {
      // Waits for an account deletion of the invitee (which locks their row
      // first), so a deleted account isn't added back; same order it takes
      const { rows: invitee } = await tx.query(
        `SELECT 1 FROM users WHERE id = $1 AND "clerkId" IS NOT NULL FOR KEY SHARE`,
        [inviteeId]
      );
      if (invitee.length === 0) throw new AppError("You can only invite friends", "NOT_FRIENDS", 403);
      const { rows: room } = await tx.query<{ name: string; livePlayer: boolean }>(
        `SELECT r.name, NOT ${notLivePlayer("r", "$2")} AS "livePlayer" FROM study_rooms r WHERE r.id = $1 FOR UPDATE`,
        [roomId, inviteeId]
      );
      if (!room[0] || !(await this.isMember(tx, roomId, inviter.id))) throw roomNotFound();
      // Fair play: nothing about a room watching their game reaches a player
      // until it is over (not even the invitation)
      if (room[0].livePlayer) {
        throw new AppError("Players of the game can join once it has ended", "GAME_IN_PROGRESS", 409);
      }
      const { rows: friendship } = await tx.query(
        `SELECT 1 FROM friends
         WHERE LEAST("userOneId", "userTwoId") = LEAST($1::int, $2::int)
           AND GREATEST("userOneId", "userTwoId") = GREATEST($1::int, $2::int)`,
        [inviter.id, inviteeId]
      );
      if (friendship.length === 0) {
        throw new AppError("You can only invite friends", "NOT_FRIENDS", 403);
      }
      const { rows: count } = await tx.query<{ n: string }>(
        `SELECT COUNT(*) AS n FROM study_room_members WHERE "roomId" = $1`,
        [roomId]
      );
      if (Number(count[0]!.n) >= MAX_ROOM_MEMBERS) {
        throw new AppError(`A room holds up to ${MAX_ROOM_MEMBERS} people`, "ROOM_FULL", 409);
      }
      const { rowCount } = await tx.query(
        `INSERT INTO study_room_members ("roomId", "userId") VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [roomId, inviteeId]
      );
      if (!rowCount) throw new AppError("Already in this room", "ALREADY_MEMBER", 409);
      await tx.query(`UPDATE study_rooms SET "updatedAt" = now() WHERE id = $1`, [roomId]);
      return room[0].name;
    });

    const members = await this.members(roomId);
    await this.publish(roomId, { type: "members", members });
    await this.hub
      .publish(topics.notifications(inviteeId), {
        type: "study_invite",
        data: { roomId, name, from: { id: inviter.id, username: inviter.username } },
      })
      .catch((err) => this.fastify.log.error({ err }, "Failed to publish study invite"));
    return members;
  }

  /** The owner removes someone, or a member leaves. The owner can't leave (delete instead). */
  async removeMember(roomId: number, actorId: number, userId: number): Promise<void> {
    const { rows } = await this.fastify.pg.query<{ ownerId: number }>(
      `SELECT "ownerId" FROM study_rooms WHERE id = $1`,
      [roomId]
    );
    // isMember also keeps a live game's players out
    const room = rows[0];
    if (!room || !(await this.isMember(this.fastify.pg, roomId, actorId))) throw roomNotFound();
    if (actorId !== userId && actorId !== room.ownerId) throw notOwner();
    if (userId === room.ownerId) {
      throw new AppError("The owner can't leave. Delete the room instead.", "OWNER_CANT_LEAVE", 409);
    }
    const { rowCount } = await this.fastify.pg.query(
      `DELETE FROM study_room_members WHERE "roomId" = $1 AND "userId" = $2`,
      [roomId, userId]
    );
    if (!rowCount) throw new AppError("Not in this room", "NOT_A_MEMBER", 404);
    await this.hub
      .publish(topics.studyUser(roomId, userId), { type: "removed" })
      .catch((err) => this.fastify.log.error({ err }, "Failed to publish study removal"));
    // Their open sockets would otherwise keep receiving the room's updates
    await this.hub
      .closeTopicSockets(topics.studyUser(roomId, userId))
      .catch((err) => this.fastify.log.error({ err }, "Failed to close removed member's sockets"));
    await this.publish(roomId, { type: "members", members: await this.members(roomId) });
  }

  /**
   * Applies a change to the room's analysis. Membership is checked in the
   * same statement or transaction, so someone removed a moment ago can't
   * slip one in.
   *
   * Moving around the tree (goto, or a move the tree already has) only
   * changes the cursor column: one UPDATE that checks in SQL that the node
   * exists, without reading or rewriting the stored document. Everything
   * else loads the document under the row lock, applies the op and writes
   * it back. Both bump the version, so clients see one sequence of changes.
   */
  async apply(roomId: number, userId: number, op: StudyOp): Promise<void> {
    // Only ops that end up rewriting the document count against
    // STUDY_WRITE_LIMIT; moving the cursor isn't counted in Redis at all
    let outcome: { change: StudyChange; version: number } | null;
    if (op.type === "sync_game") {
      outcome = await this.syncGame(roomId, userId);
    } else if (op.type === "goto") {
      outcome = await this.gotoNode(roomId, userId, op.nodeId);
    } else {
      outcome = op.type === "move" ? await this.replayMove(roomId, userId, op.nodeId, op.uci) : null;
      if (!outcome) {
        await this.limit(`study:writes:${roomId}:${userId}`, STUDY_WRITE_LIMIT);
        outcome = await this.rewrite(roomId, userId, op);
      }
    }
    if (!outcome) return;

    // Only what changed goes out: the whole document is sent on connect and
    // on "sync" alone (see MAX_STUDY_BYTES)
    const { change, version } = outcome;
    const by = userId;
    switch (change.kind) {
      case "cursor":
        return this.publish(roomId, { type: "cursor", cursor: change.cursor, version, by });
      case "node":
        return this.publish(roomId, { type: "node", node: change.node, version, by });
      case "added":
        return this.publish(roomId, { type: "node_added", node: change.node, cursor: change.cursor, version, by });
      case "deleted":
        return this.publish(roomId, {
          type: "node_deleted",
          nodeId: change.nodeId,
          parentId: change.parentId,
          cursor: change.cursor,
          version,
          by,
        });
      case "children":
        return this.publish(roomId, { type: "children", parentId: change.parentId, children: change.children, version, by });
      case "game":
        return this.publish(roomId, {
          type: "game_line",
          nodes: change.nodes,
          game: change.game,
          cursor: change.cursor,
          version,
          by,
        });
    }
  }

  /**
   * sync_game: makes the linked game's stored moves the room's main line
   * (syncGameLine). Clients send it on connect and whenever the game socket
   * delivers a move, so every member of a room sends it for the same move:
   * the first does the work, the others find nothing to do in one read
   * that takes no lock (the room already has as many moves as the game,
   * ending in the same position, and knows whether it is over). The live
   * game's own tables are only read, never locked.
   */
  private async syncGame(roomId: number, userId: number) {
    // A line stored as over is never synced again (see syncGameLine): the
    // members may have deleted some of its moves since
    const { rows } = await this.fastify.pg.query<{
      gameId: number | null;
      member: boolean;
      synced: boolean;
      version: number;
    }>(
      `SELECT r."gameId", r.version, ${memberSql("r", "$2")} AS member,
         COALESCE((r.state->'game'->>'over')::boolean, false)
         OR (COALESCE(jsonb_array_length(r.state->'game'->'line'), -1) = g."numMoves"
           AND g.status = 'in_progress'
           AND (g."numMoves" = 0 OR g.fen = r.state->'nodes'->(r.state->'game'->'line'->>-1)->>'fen')) AS synced
       FROM study_rooms r LEFT JOIN games g ON g.id = r."gameId"
       WHERE r.id = $1`,
      [roomId, userId]
    );
    const found = rows[0];
    if (!found || !found.member) throw roomNotFound();
    if (found.gameId === null) throw notLinked();
    if (found.synced) return null;

    // A room that couldn't take the line (full) isn't replayed again until
    // it has changed, and then only within the member's write limit
    const refused = await this.gameSyncRefusal(roomId);
    if (refused) {
      if (refused.version === found.version) throw new AppError(refused.message, "INVALID_STUDY_ACTION", 400);
      await this.limit(`study:writes:${roomId}:${userId}`, STUDY_WRITE_LIMIT);
    }

    const outcome = await this.fastify.pg.transact(async (tx) => {
      const { rows: locked } = await tx.query<{ state: StudyState; cursor: string; version: number }>(
        `SELECT state, cursor, version FROM study_rooms WHERE id = $1 FOR UPDATE`,
        [roomId]
      );
      const room = locked[0];
      // Asked again under the lock, as rewrite does: they may have been removed since the read above
      if (!room || !(await this.isMember(tx, roomId, userId))) throw roomNotFound();
      const { rows: games } = await tx.query<{ pgn: string | null; status: string }>(
        `SELECT pgn, status FROM games WHERE id = $1`,
        [found.gameId]
      );
      const game = games[0];
      if (!game) throw notLinked();
      let synced: ReturnType<typeof syncGameLine>;
      try {
        synced = syncGameLine(
          { ...room.state, cursor: cursorIn(room.state, room.cursor) },
          loadGame(game.pgn).history(),
          game.status !== "in_progress"
        );
      } catch (error) {
        // The tree can't take the line as it stands (full): remembered with
        // the room's version, so the next sync_game doesn't replay it again
        if (error instanceof AppError && error.code === "INVALID_STUDY_ACTION") {
          await this.fastify.redis
            .set(gameSyncRefusedKey(roomId), JSON.stringify({ version: room.version, message: error.message }), {
              expiration: { type: "EX", value: GAME_SYNC_REFUSED_TTL_SECONDS },
            })
            .catch((err) => this.fastify.log.warn({ err, roomId }, "Failed to remember a refused game sync"));
        }
        throw error;
      }
      const { state, change } = synced;
      if (change.kind === "none") return null;
      const version = room.version + 1;
      await tx.query(
        `UPDATE study_rooms SET state = $2::jsonb, cursor = $3, "nodeCount" = $4, version = $5, "updatedAt" = now()
         WHERE id = $1`,
        [roomId, storedStudyDocument(state), state.cursor, nodeCount(state), version]
      );
      return { change, version };
    });
    if (refused) {
      await this.fastify.redis
        .del(gameSyncRefusedKey(roomId))
        .catch((err) => this.fastify.log.warn({ err, roomId }, "Failed to forget a refused game sync"));
    }
    return outcome;
  }

  /** Why the room last couldn't take its game's line, and at which version (see syncGame). */
  private async gameSyncRefusal(roomId: number): Promise<{ version: number; message: string } | null> {
    const raw = await this.fastify.redis.get(gameSyncRefusedKey(roomId)).catch((err) => {
      this.fastify.log.warn({ err, roomId }, "Failed to read a refused game sync");
      return null;
    });
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw) as { version?: unknown; message?: unknown };
      return typeof parsed.version === "number" && typeof parsed.message === "string"
        ? { version: parsed.version, message: parsed.message }
        : null;
    } catch {
      return null;
    }
  }

  /**
   * Room chat for a member, in a room linked to a game: whether they can
   * write, and the latest messages. Null when the room has no chat for them:
   * the game's own players never get the room's chat, even once they are
   * invited after the game. A viewer whose game-chat setting is "nobody"
   * gets none of it ("off_by_you"); otherwise messages they couldn't have
   * been sent (a block either way, or either one's setting: roomChatBetween)
   * are left out.
   */
  private async chatState(
    roomId: number,
    gameId: number,
    viewerId: number
  ): Promise<{ enabled: boolean; reason: StudyChatOffReason | null; messages: StudyChatMessage[] } | null> {
    const { rows: games } = await this.fastify.pg.query<{
      whiteId: number;
      blackId: number;
      open: boolean;
      setting: string;
    }>(
      `SELECT "whiteId", "blackId",
         (status = 'in_progress' OR "endedAt" > now() - ($2::int * interval '1 millisecond')) AS open,
         ${chatSetting("$3")} AS setting
       FROM games WHERE id = $1`,
      [gameId, CHAT_OPEN_AFTER_END_MS, viewerId]
    );
    const game = games[0];
    if (!game || viewerId === game.whiteId || viewerId === game.blackId) return null;
    if (game.setting === "nobody") return { enabled: false, reason: "off_by_you", messages: [] };
    const { rows } = await this.fastify.pg.query<{ id: string; senderId: number; body: string; createdAt: Date }>(
      `SELECT c.id::text AS id, c."senderId", c.body, c."createdAt" FROM study_chat_messages c
       WHERE c."roomId" = $1 AND (c."senderId" = $2 OR (${roomChatBetween("$2", `c."senderId"`)}))
       ORDER BY c.id DESC LIMIT $3`,
      [roomId, viewerId, CHAT_HISTORY_LIMIT]
    );
    return {
      enabled: game.open,
      reason: game.open ? null : "closed",
      messages: rows.reverse().map(toChatMessage),
    };
  }

  /**
   * A chat message to the room (linked rooms only). Who writes always comes
   * from the authenticated socket. It goes to each member's own topic for
   * the room, except the game's players and anyone chat between them and
   * the sender is off for (roomChatBetween: a block either way, or either
   * one's game-chat setting). A sender whose setting is "nobody" can't write.
   */
  async sendChat(roomId: number, userId: number, rawText: string): Promise<void> {
    const cleaned = cleanChatText(rawText);
    if (!cleaned.ok) {
      throw cleaned.reason === "empty"
        ? new AppError("Write a message first", "CHAT_EMPTY", 400)
        : new AppError(`Messages can be up to ${CHAT_MAX_LENGTH} characters`, "CHAT_TOO_LONG", 400);
    }
    const allowed = await withinLimit(
      this.fastify.redis,
      `study:chat:${roomId}:${userId}`,
      STUDY_CHAT_BURST.max,
      STUDY_CHAT_BURST.windowSeconds
    );
    if (!allowed) throw new AppError("You're sending messages too fast. Wait a moment.", "CHAT_RATE_LIMITED", 429);

    // Membership, the chat being open, the sender not playing in the game
    // and their message count are checked in the insert itself
    const { rows } = await this.fastify.pg.query<{ id: string; senderId: number; body: string; createdAt: Date }>(
      `INSERT INTO study_chat_messages ("roomId", "senderId", body)
       SELECT r.id, $2::int, $3
       FROM study_rooms r JOIN games g ON g.id = r."gameId"
       WHERE r.id = $1 AND ${memberSql("r", "$2")}
         AND $2::int NOT IN (g."whiteId", g."blackId")
         AND ${chatSetting("$2")} <> 'nobody'
         AND (g.status = 'in_progress' OR g."endedAt" > now() - ($4::int * interval '1 millisecond'))
         AND (SELECT count(*) FROM study_chat_messages c WHERE c."roomId" = r.id AND c."senderId" = $2::int) < $5::int
       RETURNING id::text AS id, "senderId", body, "createdAt"`,
      [roomId, userId, cleaned.text, CHAT_OPEN_AFTER_END_MS, STUDY_CHAT_MAX_PER_MEMBER]
    );
    const row = rows[0];
    if (!row) throw await this.chatRefusal(roomId, userId);

    const { rows: recipients } = await this.fastify.pg.query<{ userId: number }>(
      `SELECT m."userId" FROM study_room_members m
       JOIN study_rooms r ON r.id = m."roomId"
       JOIN games g ON g.id = r."gameId"
       WHERE m."roomId" = $1 AND m."userId" NOT IN (g."whiteId", g."blackId")
         -- The sender's copy is their confirmation (and their other tabs')
         AND (m."userId" = $2 OR (${roomChatBetween(`m."userId"`, "$2")}))`,
      [roomId, userId]
    );
    const message = { type: "chat", data: toChatMessage(row) };
    await Promise.all(
      recipients.map(({ userId: recipient }) =>
        this.hub
          .publish(topics.studyUser(roomId, recipient), message)
          .catch((err) => this.fastify.log.error({ err, roomId }, "Failed to publish study chat"))
      )
    );
  }

  /**
   * Whether `reporterId` can report `reportedId` from this room
   * (ModerationService.report): the reporter is a member (a player of the
   * room's live game isn't, see memberSql), and the reported player is one
   * too or has written in the room's chat (they may have left since).
   */
  async canReportFrom(roomId: number, reporterId: number, reportedId: number): Promise<boolean> {
    const { rows } = await this.fastify.pg.query(
      `SELECT 1 FROM study_rooms r
       WHERE r.id = $1 AND ${memberSql("r", "$2")}
         AND (EXISTS (SELECT 1 FROM study_room_members m WHERE m."roomId" = r.id AND m."userId" = $3)
           OR EXISTS (SELECT 1 FROM study_chat_messages c WHERE c."roomId" = r.id AND c."senderId" = $3))`,
      [roomId, reporterId, reportedId]
    );
    return rows.length > 0;
  }

  /** Why a chat message wasn't stored (rare, so the insert doesn't pay for it). */
  private async chatRefusal(roomId: number, userId: number): Promise<AppError> {
    const { rows } = await this.fastify.pg.query<{
      member: boolean;
      linked: boolean;
      player: boolean;
      open: boolean;
      off: boolean;
    }>(
      `SELECT ${memberSql("r", "$2")} AS member, g.id IS NOT NULL AS linked,
         COALESCE($2::int IN (g."whiteId", g."blackId"), false) AS player,
         COALESCE(g.status = 'in_progress' OR g."endedAt" > now() - ($3::int * interval '1 millisecond'), false) AS open,
         ${chatSetting("$2")} = 'nobody' AS off
       FROM study_rooms r LEFT JOIN games g ON g.id = r."gameId" WHERE r.id = $1`,
      [roomId, userId, CHAT_OPEN_AFTER_END_MS]
    );
    const room = rows[0];
    if (!room || !room.member) return roomNotFound();
    if (!room.linked || room.player) return new AppError("This room has no chat", "CHAT_UNAVAILABLE", 400);
    // Same message and code as game chat (GameChatService)
    if (room.off) return new AppError("Chat is turned off in your settings", "CHAT_DISABLED", 403);
    if (!room.open) return new AppError("This chat has closed", "CHAT_CLOSED", 403);
    return new AppError(
      `You can send up to ${STUDY_CHAT_MAX_PER_MEMBER} messages in one room`,
      "CHAT_LIMIT_REACHED",
      429
    );
  }

  /**
   * Deletes room chat on game chat's schedule: messages of rooms whose game
   * ended before `before` (or is gone), a batch at a time.
   */
  async sweepChat(before: Date, batch = 1_000): Promise<void> {
    for (;;) {
      const { rowCount } = await this.fastify.pg.query(
        `DELETE FROM study_chat_messages WHERE id IN (
           SELECT c.id FROM study_chat_messages c
           JOIN study_rooms r ON r.id = c."roomId"
           LEFT JOIN games g ON g.id = r."gameId"
           WHERE g.id IS NULL OR g."endedAt" < $1
           LIMIT $2)`,
        [before, batch]
      );
      if ((rowCount ?? 0) < batch) return;
    }
  }

  /**
   * Counts an op against a per-player, per-room limit shared by every
   * instance. If Redis can't be reached the op goes ahead: the socket's own
   * limit still applies, and the room is unusable without Redis anyway.
   */
  private async limit(key: string, { max, windowSeconds }: { max: number; windowSeconds: number }) {
    const allowed = await withinLimit(this.fastify.redis, key, max, windowSeconds).catch((err) => {
      this.fastify.log.warn({ err }, "Study rate limit unavailable");
      return true;
    });
    if (!allowed) throw tooFast();
  }

  /**
   * goto: moves the cursor if the node is in the tree. The row's other
   * columns are copied as they are; the document is only read by Postgres
   * for the key check, never sent here or written. A concurrent change to
   * the tree holds the row lock, and the WHERE is checked again against
   * what it wrote.
   */
  private async gotoNode(roomId: number, userId: number, nodeId: string) {
    const { rows } = await this.fastify.pg.query<{ version: number }>(
      `UPDATE study_rooms r SET cursor = $2, version = r.version + 1, "updatedAt" = now()
       WHERE r.id = $1 AND r.cursor <> $2 AND r.state->'nodes' ? $2
         AND ${memberSql("r", "$3")}
       RETURNING r.version`,
      [roomId, nodeId, userId]
    );
    if (rows[0]) return { change: { kind: "cursor", cursor: nodeId } as const, version: rows[0].version };

    // Nothing changed: find out why (rare, so the UPDATE doesn't pay for it)
    const { rows: found } = await this.fastify.pg.query<{ atNode: boolean; hasNode: boolean; member: boolean }>(
      `SELECT r.cursor = $2 AS "atNode", r.state->'nodes' ? $2 AS "hasNode",
         ${memberSql("r", "$3")} AS member
       FROM study_rooms r WHERE r.id = $1`,
      [roomId, nodeId, userId]
    );
    const room = found[0];
    if (!room || !room.member) throw roomNotFound();
    if (!room.hasNode) throw positionGone();
    return null; // already there
  }

  /**
   * A move the tree already has from that node (replaying a line): the
   * cursor goes to that child. Null when the tree doesn't have the move (or
   * the node, or the room); the caller then applies the op in full, which
   * adds the move or says what is wrong. The child is looked up in the
   * locked row, so a change committed meanwhile is taken into account.
   */
  private async replayMove(roomId: number, userId: number, parentId: string, uci: string) {
    const { rows } = await this.fastify.pg.query<{ version: number; cursor: string }>(
      `WITH target AS (
         SELECT r.id, jsonb_path_query_first(r.state, '$.nodes.* ? (@.parentId == $p && @.uci == $u).id',
                  jsonb_build_object('p', $2::text, 'u', $3::text)) #>> '{}' AS child
         FROM study_rooms r
         WHERE r.id = $1
           AND ${memberSql("r", "$4")}
         FOR UPDATE OF r
       )
       UPDATE study_rooms r SET cursor = target.child, version = r.version + 1, "updatedAt" = now()
       FROM target WHERE r.id = target.id AND target.child IS NOT NULL
       RETURNING r.version, r.cursor`,
      [roomId, parentId, uci, userId]
    );
    const row = rows[0];
    return row ? { change: { kind: "cursor", cursor: row.cursor } as const, version: row.version } : null;
  }

  /** Any other op: the document is loaded under the row lock, changed and written back. */
  private async rewrite(roomId: number, userId: number, op: StudyOp) {
    return this.fastify.pg.transact(async (tx) => {
      const { rows } = await tx.query<{ state: StudyState; cursor: string; version: number }>(
        `SELECT state, cursor, version FROM study_rooms WHERE id = $1 FOR UPDATE`,
        [roomId]
      );
      const room = rows[0];
      if (!room || !(await this.isMember(tx, roomId, userId))) throw roomNotFound();
      const { state, change } = applyStudyOp({ ...room.state, cursor: cursorIn(room.state, room.cursor) }, op);
      if (change.kind === "none") return null;
      const version = room.version + 1;
      if (change.kind === "cursor") {
        // A move that someone else added a moment ago: the document is as it was
        await tx.query(
          `UPDATE study_rooms SET cursor = $2, version = $3, "updatedAt" = now() WHERE id = $1`,
          [roomId, state.cursor, version]
        );
      } else {
        await tx.query(
          `UPDATE study_rooms SET state = $2::jsonb, cursor = $3, "nodeCount" = $4, version = $5, "updatedAt" = now()
           WHERE id = $1`,
          [roomId, storedStudyDocument(state), state.cursor, nodeCount(state), version]
        );
      }
      return { change, version };
    });
  }

  /** Users with the room open right now. */
  async present(roomId: number): Promise<number[]> {
    return this.hub.memberUserIds(studyPresenceKey(roomId));
  }

  /** Tells the room who has it open. Never throws. */
  async publishPresence(roomId: number): Promise<void> {
    try {
      await this.publish(roomId, { type: "presence", userIds: await this.present(roomId) });
    } catch (err) {
      this.fastify.log.error({ err, roomId }, "Failed to publish study presence");
    }
  }

  private async publish(roomId: number, message: object): Promise<void> {
    await this.hub
      .publish(topics.study(roomId), message)
      .catch((err) => this.fastify.log.error({ err, roomId }, "Failed to publish study update"));
  }
}
