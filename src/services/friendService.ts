import type { FastifyInstance } from "fastify";
import { FriendRepository } from "../repositories/friendRepository.js";
import { UserRepository } from "../repositories/userRepository.js";
import type {
  PaginatedFriendsResponse,
  FriendRequest,
  PaginatedFriendRequestsResponse,
  Friend,
  FriendSuggestion,
  FriendListItem,
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
  private userRepository: UserRepository;

  constructor(fastify: FastifyInstance) {
    this.friendRepository = new FriendRepository(fastify);
    this.userRepository = new UserRepository(fastify);
  }

  /**
   * Get friend suggestions for a user
   * If searchQuery provided, search for users matching the query
   * Otherwise return random suggestions
   *
   * @param userId - The ID of the user requesting suggestions
   * @param searchQuery - Optional search string to filter users by username
   * @returns Array of friend suggestions (max 5)
   */
  async getFriendSuggestions(
    userId: number,
    searchQuery?: string
  ): Promise<FriendSuggestion[]> {
    const limit = FRIEND_CONFIG.MAX_SUGGESTIONS;
    const offset = 0;

    let suggestions: FriendSuggestion[];

    if (searchQuery) {
      // Search for users matching the query
      const result = await this.friendRepository.searchUsers(
        userId,
        searchQuery,
        limit,
        offset
      );
      suggestions = result.suggestions;
    } else {
      // Get random friend suggestions
      const result = await this.friendRepository.getFriendSuggestions(
        userId,
        limit,
        offset
      );
      suggestions = result.suggestions;
    }

    return suggestions;
  }

  /**
   * Get user's friends list with pagination
   * Optionally filter by username search query
   *
   * @param userId - The ID of the user whose friends to retrieve
   * @param page - Page number (1-indexed)
   * @param limit - Number of results per page
   * @param searchQuery - Optional search string to filter friends by username
   * @returns Paginated list of friends with metadata
   */
  async getFriends(
    userId: number,
    page: number,
    limit: number,
    searchQuery?: string
  ): Promise<PaginatedFriendsResponse> {
    const offset = (page - 1) * limit;

    // Get user's friends list from repository
    const { friends, total } = await this.friendRepository.getFriends(
      userId,
      limit,
      offset,
      searchQuery
    );

    const totalPages = Math.ceil(total / limit);

    return {
      data: friends,
      pagination: {
        page,
        limit,
        total,
        totalPages,
      },
    };
  }

  /**
   * Send a friend request from one user to another
   * Validates that the request is valid before creating it
   *
   * @param senderId - ID of the user sending the request
   * @param senderUsername - Username of the sender
   * @param senderAvatarUrl - Avatar URL of the sender
   * @param receiverId - ID of the user receiving the request
   * @returns The created friend request
   * @throws {SelfFriendRequestError} If trying to send request to self
   * @throws {UserNotFoundError} If receiver doesn't exist
   * @throws {FriendshipExistsError} If users are already friends
   * @throws {FriendRequestExistsError} If a request already exists between users
   */
  async sendFriendRequest(
    senderId: number,
    senderUsername: string,
    senderAvatarUrl: string | null,
    receiverId: number
  ): Promise<FriendRequest> {
    // Validate: cannot send request to self
    if (senderId === receiverId) {
      throw new SelfFriendRequestError(
        "Cannot send friend request to yourself"
      );
    }

    // Validate: receiver must exist
    const receiverBasic = await this.userRepository.findById(receiverId);
    if (!receiverBasic) {
      throw new UserNotFoundError(`User with ID ${receiverId} not found`);
    }

    // Validate: users are not already friends
    const areFriends = await this.friendRepository.areFriends(
      senderId,
      receiverId
    );
    if (areFriends) {
      throw new FriendshipExistsError("Already friends with this user");
    }

    // Validate: no pending request exists
    const requestExists = await this.friendRepository.friendRequestExists(
      senderId,
      receiverId
    );
    if (requestExists) {
      throw new FriendRequestExistsError(
        "Friend request already exists between these users"
      );
    }

    return await this.friendRepository.createFriendRequest(
      senderId,
      senderUsername,
      senderAvatarUrl,
      receiverBasic.id,
      receiverBasic.username,
      receiverBasic.avatarUrl
    );
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
   * Accept a friend request, creating a friendship
   * Only the receiver of the request can accept it
   *
   * @param requestId - The ID of the friend request to accept
   * @param userId - The ID of the user accepting the request
   * @returns The created friendship
   * @throws {FriendRequestNotFoundError} If the request doesn't exist
   * @throws {UnauthorizedFriendActionError} If user is not the receiver
   */
  async acceptFriendRequest(
    requestId: number,
    userId: number
  ): Promise<Friend> {
    const request = await this.friendRepository.getFriendRequestById(requestId);
    if (!request) {
      throw new FriendRequestNotFoundError(
        `Friend request with ID ${requestId} not found`
      );
    }

    // Validate: user must be the receiver of this request
    if (request.receiverId !== userId) {
      throw new UnauthorizedFriendActionError(
        "Not authorized to accept this friend request"
      );
    }

    return await this.friendRepository.acceptFriendRequest(requestId);
  }

  /**
   * Decline a friend request (delete without creating friendship)
   * Only the receiver of the request can decline it
   *
   * @param requestId - The ID of the friend request to decline
   * @param userId - The ID of the user declining the request
   * @throws {FriendRequestNotFoundError} If the request doesn't exist
   * @throws {UnauthorizedFriendActionError} If user is not the receiver
   */
  async declineFriendRequest(requestId: number, userId: number): Promise<void> {
    const request = await this.friendRepository.getFriendRequestById(requestId);
    if (!request) {
      throw new FriendRequestNotFoundError(
        `Friend request with ID ${requestId} not found`
      );
    }

    // Validate: user must be the receiver of this request
    if (request.receiverId !== userId) {
      throw new UnauthorizedFriendActionError(
        "Not authorized to decline this friend request"
      );
    }

    await this.friendRepository.deleteFriendRequest(requestId);
  }

  /**
   * Cancel a friend request (delete an outgoing request)
   * Only the sender of the request can cancel it
   *
   * @param requestId - The ID of the friend request to cancel
   * @param userId - The ID of the user canceling the request
   * @throws {FriendRequestNotFoundError} If the request doesn't exist
   * @throws {UnauthorizedFriendActionError} If user is not the sender
   */
  async cancelFriendRequest(requestId: number, userId: number): Promise<void> {
    const request = await this.friendRepository.getFriendRequestById(requestId);
    if (!request) {
      throw new FriendRequestNotFoundError(
        `Friend request with ID ${requestId} not found`
      );
    }

    // Validate: user must be the sender of this request
    if (request.senderId !== userId) {
      throw new UnauthorizedFriendActionError(
        "Not authorized to cancel this friend request"
      );
    }

    await this.friendRepository.deleteFriendRequest(requestId);
  }

  /**
   * Delete a friendship between two users
   * Either user in the friendship can delete it
   *
   * @param userId - The ID of the user deleting the friendship
   * @param friendId - The ID of the friend to remove
   * @throws {FriendNotFoundError} If users are not friends
   */
  async deleteFriendship(userId: number, friendId: number): Promise<void> {
    // Validate: users must be friends
    const areFriends = await this.friendRepository.areFriends(userId, friendId);
    if (!areFriends) {
      throw new FriendNotFoundError("Not friends with this user");
    }

    const deleted = await this.friendRepository.deleteFriendship(
      userId,
      friendId
    );

    // This should not happen given the validation above, but handle edge case
    if (!deleted) {
      throw new FriendNotFoundError("Failed to delete friendship");
    }
  }
}
