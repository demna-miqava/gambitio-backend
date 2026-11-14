import type { FastifyInstance } from "fastify";
import type { Queryable } from "../db.js";
import { AppError } from "../errors/AppError.js";
import { topics, type RealtimeHub } from "../realtime/hub.js";
import {
  applyStudyOp,
  createStudyState,
  type StudyOp,
  type StudyState,
} from "../game/studyState.js";

/** Rooms one player may own. */
export const MAX_ROOMS_PER_OWNER = 30;
/** People in one room, the owner included. */
export const MAX_ROOM_MEMBERS = 20;

/** Redis set of the sockets open on a room; see RealtimeHub.addMembership. */
export const studyPresenceKey = (roomId: number) => `presence:study:${roomId}`;

export interface StudyMember {
  id: number;
  username: string;
  avatarUrl: string | null;
}

export interface StudyRoomMeta {
  id: number;
  name: string;
  ownerId: number;
  createdAt: Date;
  updatedAt: Date;
  version: number;
}

export interface StudyRoomListItem extends Omit<StudyRoomMeta, "version"> {
  ownerUsername: string;
  memberCount: number;
  moveCount: number;
}

const roomNotFound = () => new AppError("Study room not found", "STUDY_NOT_FOUND", 404);
const notOwner = () => new AppError("Only the room's owner can do that", "NOT_STUDY_OWNER", 403);

/**
 * Shared study rooms. Every change to a room's analysis runs in a
 * transaction holding the room's row lock and bumps its version; messages
 * go out only after it commits. Only members can see or change a room.
 */
export class StudyService {
  constructor(
    private fastify: FastifyInstance,
    private hub: RealtimeHub
  ) {}

  private async isMember(db: Queryable, roomId: number, userId: number) {
    const { rows } = await db.query(
      `SELECT 1 FROM study_room_members WHERE "roomId" = $1 AND "userId" = $2`,
      [roomId, userId]
    );
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
    const { rows } = await this.fastify.pg.query<
      Omit<StudyRoomListItem, "moveCount" | "memberCount"> & { memberCount: string; nodeCount: string }
    >(
      `SELECT r.id, r.name, r."ownerId", r."createdAt", r."updatedAt", o.username AS "ownerUsername",
         (SELECT COUNT(*) FROM study_room_members c WHERE c."roomId" = r.id) AS "memberCount",
         (SELECT COUNT(*) FROM jsonb_object_keys(r.state->'nodes')) AS "nodeCount"
       FROM study_room_members m
       JOIN study_rooms r ON r.id = m."roomId"
       JOIN users o ON o.id = r."ownerId"
       WHERE m."userId" = $1
       ORDER BY r."updatedAt" DESC
       LIMIT 100`,
      [userId]
    );
    return rows.map(({ memberCount, nodeCount, ...room }) => ({
      ...room,
      memberCount: Number(memberCount),
      moveCount: Math.max(0, Number(nodeCount) - 1),
    }));
  }

  async create(
    ownerId: number,
    input: { name: string; fen?: string | undefined; moves?: string[] | undefined }
  ): Promise<StudyRoomMeta> {
    const state = createStudyState({ fen: input.fen, moves: input.moves });
    return this.fastify.pg.transact(async (tx) => {
      // Serialises room creation per owner, so the limit holds
      await tx.query(`SELECT 1 FROM users WHERE id = $1 FOR UPDATE`, [ownerId]);
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
        `INSERT INTO study_rooms ("ownerId", name, state) VALUES ($1, $2, $3::jsonb)
         RETURNING id, name, "ownerId", "createdAt", "updatedAt", version`,
        [ownerId, input.name.trim(), JSON.stringify(state)]
      );
      const room = rows[0]!;
      await tx.query(`INSERT INTO study_room_members ("roomId", "userId") VALUES ($1, $2)`, [room.id, ownerId]);
      return room;
    });
  }

  /** Room, analysis and members, for a member. */
  async get(roomId: number, userId: number) {
    await this.assertMember(roomId, userId);
    const { rows } = await this.fastify.pg.query<StudyRoomMeta & { state: StudyState }>(
      `SELECT id, name, "ownerId", "createdAt", "updatedAt", version, state FROM study_rooms WHERE id = $1`,
      [roomId]
    );
    const row = rows[0];
    if (!row) throw roomNotFound();
    const { state, ...room } = row;
    return { room, state, members: await this.members(roomId) };
  }

  async rename(roomId: number, userId: number, name: string): Promise<StudyRoomMeta> {
    const { rows } = await this.fastify.pg.query<StudyRoomMeta>(
      `UPDATE study_rooms SET name = $3, "updatedAt" = now()
       WHERE id = $1 AND "ownerId" = $2
       RETURNING id, name, "ownerId", "createdAt", "updatedAt", version`,
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
      const { rows: room } = await tx.query<{ name: string }>(
        `SELECT name FROM study_rooms WHERE id = $1 FOR UPDATE`,
        [roomId]
      );
      if (!room[0] || !(await this.isMember(tx, roomId, inviter.id))) throw roomNotFound();
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
   * same transaction, so someone removed a moment ago can't slip one in.
   */
  async apply(roomId: number, userId: number, op: StudyOp): Promise<void> {
    const outcome = await this.fastify.pg.transact(async (tx) => {
      const { rows } = await tx.query<{ state: StudyState; version: number }>(
        `SELECT state, version FROM study_rooms WHERE id = $1 FOR UPDATE`,
        [roomId]
      );
      const room = rows[0];
      if (!room || !(await this.isMember(tx, roomId, userId))) throw roomNotFound();
      const { state, change } = applyStudyOp(room.state, op);
      if (change.kind === "none") return null;
      const version = room.version + 1;
      await tx.query(
        `UPDATE study_rooms SET state = $2::jsonb, version = $3, "updatedAt" = now() WHERE id = $1`,
        [roomId, JSON.stringify(state), version]
      );
      return { state, change, version };
    });
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
    }
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
