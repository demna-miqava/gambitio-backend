import type { FastifyInstance } from "fastify";
import { FriendRepository } from "../repositories/friendRepository.js";
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
 * Service layer for managing friend relationships and friend requests
 * Handles business logic and validation before delegating to repositories
 */
export class FriendService {
  private friendRepository: FriendRepository;

  constructor(fastify: FastifyInstance) {
    this.friendRepository = new FriendRepository(fastify);
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
    const exists = () =>
      new FriendRequestExistsError("Friend request already exists between these users");
    if (context.requestExists) throw exists();

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
    if (friendship) return friendship;
    throw await this.requestError(requestId, "Not authorized to accept this friend request");
  }

  /**
   * Decline a friend request (delete without creating friendship). Only the
   * receiver of the request can decline it.
   */
  async declineFriendRequest(requestId: number, userId: number): Promise<void> {
    if (await this.friendRepository.deleteFriendRequestAs(requestId, userId, "receiverId")) return;
    throw await this.requestError(requestId, "Not authorized to decline this friend request");
  }

  /**
   * Cancel a friend request (delete an outgoing request). Only the sender of
   * the request can cancel it.
   */
  async cancelFriendRequest(requestId: number, userId: number): Promise<void> {
    if (await this.friendRepository.deleteFriendRequestAs(requestId, userId, "senderId")) return;
    throw await this.requestError(requestId, "Not authorized to cancel this friend request");
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
  }
}
