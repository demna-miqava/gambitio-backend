import type { FastifyInstance } from "fastify";
import { FriendRepository } from "../repositories/friendRepository.js";
import { topics } from "../realtime/hub.js";
import { AppError } from "../errors/AppError.js";
import { blocksBetween } from "../repositories/blockRepository.js";
import { withinLimit } from "../utils/rateLimit.js";
import type {
  FriendRequest,
  PaginatedFriendRequestsResponse,
  Friend,
  FriendSuggestion,
} from "../models/Friend.js";
import {
  SelfFriendRequestError,
  UserNotFoundError,
  FriendshipExistsError,
  FriendRequestExistsError,
  FriendRequestNotFoundError,
  UnauthorizedFriendActionError,
  FriendNotFoundError,
} from "../errors/index.js";

/**
 * Configuration constants for friend-related operations
 */
const FRIEND_CONFIG = {
  MAX_SUGGESTIONS: 5,
  DEFAULT_PAGE_SIZE: 10,
  MAX_PAGE_SIZE: 100,
} as const;

/**
 * Limits on friend requests, so sending one (a list update and a push
 * notification for the receiver) can't be used to pester:
 *
 * - After cancelling a request, the sender can't send that player another
 *   for an hour: send-then-cancel can't be looped.
 * - After a decline, the sender can't ask that player again for a day (the
 *   player who declined can still send one themselves).
 * - One account can send FRIEND_REQUESTS_PER_DAY requests a day.
 * - The receiver's push notification for a sender's request goes at most
 *   once a day (PushService dedupes by tag).
 *
 * A request to someone who has blocked the sender gets the same refusal as
 * a cooldown, so it doesn't reveal the block.
 */
const FRIEND_REQUEST_LIMITS = {
  cancelCooldownSeconds: 60 * 60,
  declineCooldownSeconds: 24 * 60 * 60,
  perDay: 50,
  pushDedupeSeconds: 24 * 60 * 60,
};
const cooldownKey = (senderId: number, receiverId: number) => `friendreq:cooldown:${senderId}:${receiverId}`;

/** The refusal for a cooldown, and for a block (which it doesn't reveal) */
const cooldownError = () =>
  new AppError(
    "You can't send this player a friend request right now. Try again later.",
    "FRIEND_REQUEST_COOLDOWN",
    429
  );

/** What changed, from the point of view of the user being told. */
export type FriendsEvent =
  | "request_received"
  | "request_accepted"
  | "request_declined"
  | "request_cancelled"
  | "removed";

/**
 * Sent on the other user's notifications topic whenever a request or
 * friendship between them changes, so their lists update without a reload.
 */
export const friendsUpdatedMessage = (
  event: FriendsEvent,
  user: { id: number; username?: string; avatarUrl?: string | null }
) => ({ type: "friends_updated", data: { event, user } });

/**
 * Service layer for managing friend relationships and friend requests
 * Handles business logic and validation before delegating to repositories
 */
export class FriendService {
  private friendRepository: FriendRepository;

  constructor(private fastify: FastifyInstance) {
    this.friendRepository = new FriendRepository(fastify);
  }

  /** Tells `userId` (on every tab and instance) that something changed. Never throws. */
  private async notify(userId: number, message: ReturnType<typeof friendsUpdatedMessage>) {
    await this.fastify.hub
      .publish(topics.notifications(userId), message)
      .catch((err) => this.fastify.log.error({ err, userId }, "Failed to publish friends update"));
  }

  /**
   * Up to MAX_SUGGESTIONS users to add: matching `searchQuery` when given,
   * otherwise a random handful.
   */
  async getFriendSuggestions(userId: number, searchQuery?: string): Promise<FriendSuggestion[]> {
    const limit = FRIEND_CONFIG.MAX_SUGGESTIONS;
    return searchQuery
      ? this.friendRepository.searchUsers(userId, searchQuery, limit)
      : this.friendRepository.getFriendSuggestions(userId, limit);
  }

  /**
   * Send a friend request from one user to another
   *
   * @throws {SelfFriendRequestError} If trying to send request to self
   * @throws {UserNotFoundError} If receiver doesn't exist
   * @throws {FriendshipExistsError} If users are already friends
   * @throws {FriendRequestExistsError} If a request already exists between users
   */
  async sendFriendRequest(
    senderId: number,
    senderUsername: string,
    receiverId: number
  ): Promise<FriendRequest> {
    if (senderId === receiverId) {
      throw new SelfFriendRequestError("Cannot send friend request to yourself");
    }

    const context = await this.friendRepository.getRequestContext(senderId, receiverId);
    if (!context.receiver) {
      throw new UserNotFoundError(`User with ID ${receiverId} not found`);
    }
    if (context.areFriends) {
      throw new FriendshipExistsError("Already friends with this user");
    }
    const blocks = await blocksBetween(this.fastify.pg, senderId, receiverId);
    if (blocks.byFirst) {
      throw new AppError("You've blocked this player. Unblock them first.", "BLOCKED_BY_YOU", 403);
    }
    // The same answer as a cooldown, so the block isn't revealed: there is
    // no setting that turns friend requests off, so any other wording would
    // only ever mean a block
    if (blocks.bySecond) throw cooldownError();
    const exists = () =>
      new FriendRequestExistsError("Friend request already exists between these users");
    if (context.requestExists) throw exists();
    if (await this.fastify.redis.exists(cooldownKey(senderId, receiverId))) throw cooldownError();
    const allowed = await withinLimit(
      this.fastify.redis,
      `friendreq:sent:${senderId}`,
      FRIEND_REQUEST_LIMITS.perDay,
      24 * 60 * 60
    );
    if (!allowed) {
      throw new AppError(
        "You've sent a lot of friend requests today. Try again tomorrow.",
        "FRIEND_REQUEST_RATE_LIMITED",
        429
      );
    }

    const created = await this.friendRepository.createFriendRequest(
      senderId,
      senderUsername,
      context.senderAvatarUrl,
      context.receiver.id,
      context.receiver.username,
      context.receiver.avatarUrl
    );
    // Sent at the same moment as one the other way
    if (!created) throw exists();
    await this.notify(
      created.receiverId,
      friendsUpdatedMessage("request_received", {
        id: senderId,
        username: senderUsername,
        avatarUrl: context.senderAvatarUrl,
      })
    );
    void this.fastify.push.notify(
      created.receiverId,
      {
        title: "New friend request",
        body: `${senderUsername} wants to be friends.`,
        url: `/profile/${created.receiverId}/friends`,
        tag: `friend-request-${senderId}`,
      },
      24 * 60 * 60,
      { dedupeSeconds: FRIEND_REQUEST_LIMITS.pushDedupeSeconds }
    );
    return created;
  }

  /**
   * Get all pending friend requests for a user
   * Returns both incoming requests (received) and outgoing requests (sent)
   *
   * @param userId - The ID of the user
   * @returns Object containing arrays of incoming and outgoing requests
   */
  async getPendingFriendRequests(
    userId: number
  ): Promise<PaginatedFriendRequestsResponse> {
    const { incoming, outgoing } =
      await this.friendRepository.getPendingFriendRequests(userId);

    return {
      incoming,
      outgoing,
    };
  }

  /**
   * Accept a friend request, creating a friendship. Only the receiver of the
   * request can accept it.
   *
   * @throws {FriendRequestNotFoundError} If the request doesn't exist
   * @throws {UnauthorizedFriendActionError} If user is not the receiver
   */
  async acceptFriendRequest(requestId: number, userId: number): Promise<Friend> {
    const friendship = await this.friendRepository.acceptFriendRequest(requestId, userId);
    if (friendship) {
      // userOne is the request's sender, userTwo its receiver (who accepted)
      await this.notify(
        friendship.userOneId,
        friendsUpdatedMessage("request_accepted", {
          id: friendship.userTwoId,
          username: friendship.userTwoUsername,
        })
      );
      void this.fastify.push.notify(
        friendship.userOneId,
        {
          title: "Friend request accepted",
          body: `You and ${friendship.userTwoUsername} are now friends.`,
          url: `/profile/${friendship.userTwoId}`,
          tag: `friend-accepted-${friendship.userTwoId}`,
        },
        24 * 60 * 60
      );
      return friendship;
    }
    throw await this.requestError(requestId, "Not authorized to accept this friend request");
  }

  /**
   * Decline a friend request (delete without creating friendship). Only the
   * receiver of the request can decline it.
   */
  async declineFriendRequest(requestId: number, userId: number): Promise<void> {
    const declined = await this.friendRepository.deleteFriendRequestAs(requestId, userId, "receiverId");
    if (declined) {
      const { senderId, receiverId } = declined;
      await this.startCooldown(senderId, receiverId, FRIEND_REQUEST_LIMITS.declineCooldownSeconds);
      await this.notify(declined.senderId, friendsUpdatedMessage("request_declined", { id: userId }));
      return;
    }
    throw await this.requestError(requestId, "Not authorized to decline this friend request");
  }

  /**
   * Cancel a friend request (delete an outgoing request). Only the sender of
   * the request can cancel it.
   */
  async cancelFriendRequest(requestId: number, userId: number): Promise<void> {
    const cancelled = await this.friendRepository.deleteFriendRequestAs(requestId, userId, "senderId");
    if (cancelled) {
      const { senderId, receiverId } = cancelled;
      await this.startCooldown(senderId, receiverId, FRIEND_REQUEST_LIMITS.cancelCooldownSeconds);
      await this.notify(cancelled.receiverId, friendsUpdatedMessage("request_cancelled", { id: userId }));
      return;
    }
    throw await this.requestError(requestId, "Not authorized to cancel this friend request");
  }

  /**
   * The sender can't send the receiver another request for a while (see
   * FRIEND_REQUEST_LIMITS). A longer cooldown already running is kept: a
   * cancel doesn't shorten a decline's. Never throws.
   */
  private async startCooldown(senderId: number, receiverId: number, seconds: number): Promise<void> {
    const key = cooldownKey(senderId, receiverId);
    try {
      const ttl = await this.fastify.redis.ttl(key);
      if (ttl >= seconds) return;
      await this.fastify.redis.set(key, "1", { expiration: { type: "EX", value: seconds } });
    } catch (err) {
      this.fastify.log.warn({ err }, "Recording a friend request cooldown failed");
    }
  }

  /**
   * Why acting on a request failed: it doesn't exist, or it isn't this
   * user's to act on. Only looked up on the failure path.
   */
  private async requestError(requestId: number, unauthorizedMessage: string): Promise<Error> {
    const request = await this.friendRepository.getFriendRequestById(requestId);
    return request
      ? new UnauthorizedFriendActionError(unauthorizedMessage)
      : new FriendRequestNotFoundError(`Friend request with ID ${requestId} not found`);
  }

  /**
   * Delete a friendship between two users. Either user in the friendship can
   * delete it.
   *
   * @throws {FriendNotFoundError} If users are not friends
   */
  async deleteFriendship(userId: number, friendId: number): Promise<void> {
    if (!(await this.friendRepository.deleteFriendship(userId, friendId))) {
      throw new FriendNotFoundError("Not friends with this user");
    }
    await this.notify(friendId, friendsUpdatedMessage("removed", { id: userId }));
  }
}
