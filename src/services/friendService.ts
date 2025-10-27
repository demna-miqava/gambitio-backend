import type { FastifyInstance } from "fastify";
import { FriendRepository } from "../repositories/friendRepository.js";
import type {
  PaginatedFriendsResponse,
  FriendRequest,
  PaginatedFriendRequestsResponse,
  Friend,
  FriendSuggestion,
} from "../models/Friend.js";

export class FriendService {
  private friendRepository: FriendRepository;

  constructor(fastify: FastifyInstance) {
    this.friendRepository = new FriendRepository(fastify);
  }

  /**
   * Get friend suggestions (max 5)
   * If query provided, search users; otherwise return random suggestions
   */
  async getFriendSuggestions(
    userId: number,
    searchQuery?: string
  ): Promise<{ data: FriendSuggestion[] }> {
    const limit = 5;
    const offset = 0;

    let suggestions;

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

    return {
      data: suggestions,
    };
  }

  /**
   * Get user's friends list (paginated)
   * If searchQuery provided, filter friends by username
   */
  async getFriends(
    userId: number,
    page: number,
    limit: number,
    searchQuery?: string
  ): Promise<PaginatedFriendsResponse> {
    const offset = (page - 1) * limit;
    console.log("searchQuery", searchQuery);
    try {
      const { suggestions: friends, total } =
        await this.friendRepository.getFriends(
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
    } catch (err) {
      console.log("error", err);
    }
    // Return user's friends list
  }

  /**
   * Send friend request
   */
  async sendFriendRequest(
    senderId: number,
    senderUsername: string,
    senderAvatarUrl: string | null,
    receiverId: number
  ): Promise<FriendRequest> {
    // Check if trying to send request to self
    if (senderId === receiverId) {
      throw new Error("Cannot send friend request to yourself");
    }

    // Get receiver info
    const receiver = await this.friendRepository.getUserById(receiverId);
    if (!receiver) {
      throw new Error("User not found");
    }

    // Check if already friends
    const areFriends = await this.friendRepository.areFriends(
      senderId,
      receiverId
    );
    if (areFriends) {
      throw new Error("Already friends with this user");
    }

    // Check if friend request already exists
    const requestExists = await this.friendRepository.friendRequestExists(
      senderId,
      receiverId
    );
    if (requestExists) {
      throw new Error("Friend request already exists");
    }

    // Create friend request
    return await this.friendRepository.createFriendRequest(
      senderId,
      senderUsername,
      senderAvatarUrl,
      receiver.id,
      receiver.username,
      receiver.avatarUrl
    );
  }

  /**
   * Get pending friend requests (both incoming and outgoing)
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
   * Accept friend request
   */
  async acceptFriendRequest(
    requestId: number,
    userId: number
  ): Promise<Friend> {
    const request = await this.friendRepository.getFriendRequestById(requestId);
    if (!request) {
      throw new Error("Friend request not found");
    }

    // Verify the user is the receiver of this request
    if (request.receiverId !== userId) {
      throw new Error("Not authorized to accept this friend request");
    }

    return await this.friendRepository.acceptFriendRequest(requestId);
  }

  /**
   * Decline friend request
   */
  async declineFriendRequest(requestId: number, userId: number): Promise<void> {
    const request = await this.friendRepository.getFriendRequestById(requestId);
    if (!request) {
      throw new Error("Friend request not found");
    }

    // Verify the user is the receiver of this request
    if (request.receiverId !== userId) {
      throw new Error("Not authorized to decline this friend request");
    }

    await this.friendRepository.declineFriendRequest(requestId);
  }

  /**
   * Cancel friend request (for outgoing requests)
   */
  async cancelFriendRequest(requestId: number, userId: number): Promise<void> {
    const request = await this.friendRepository.getFriendRequestById(requestId);
    if (!request) {
      throw new Error("Friend request not found");
    }

    // Verify the user is the sender of this request
    if (request.senderId !== userId) {
      throw new Error("Not authorized to cancel this friend request");
    }

    await this.friendRepository.cancelFriendRequest(requestId);
  }

  /**
   * Delete friendship
   */
  async deleteFriendship(userId: number, friendId: number): Promise<void> {
    // Check if they are actually friends
    const areFriends = await this.friendRepository.areFriends(userId, friendId);
    if (!areFriends) {
      throw new Error("Not friends with this user");
    }

    const deleted = await this.friendRepository.deleteFriendship(
      userId,
      friendId
    );
    if (!deleted) {
      throw new Error("Failed to delete friendship");
    }
  }
}
