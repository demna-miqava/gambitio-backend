export interface Friend {
  id: number;
  createdAt: Date;
  userOneId: number;
  userTwoId: number;
  userOneUsername: string;
  userTwoUsername: string;
}

export interface FriendRequest {
  id: number;
  createdAt: Date;
  senderId: number;
  receiverId: number;
  senderUsername: string;
  receiverUsername: string;
  senderAvatarUrl: string | null;
  receiverAvatarUrl: string | null;
}

export interface FriendResponse {
  id: number;
  username: string;
}

/**
 * Friendship status enum
 */
export enum FriendshipStatus {
  PENDING = 'pending',
  ACCEPTED = 'accepted',
  DECLINED = 'declined',
  CANCELLED = 'cancelled',
}

/**
 * Base user profile fields shared across different contexts
 */
export interface UserProfile {
  id: number;
  oddsId?: string;
  username: string;
  avatarUrl: string | null;
  ratings?: {
    blitz?: number;
    bullet?: number;
    rapid?: number;
  };
}

/**
 * User suggestion for friend search/suggestions (no friendsSince)
 */
export interface FriendSuggestion extends UserProfile {
  // Inherits all UserProfile fields
  // No friendsSince for suggestions
}

/**
 * Friend list item with additional friendship metadata
 * Uses flat rating fields for backwards compatibility with frontend
 */
export interface FriendListItem {
  id: number;
  username: string;
  avatarUrl: string | null;
  friendsSince: Date;
  blitzRating: number | null;
  bulletRating: number | null;
  rapidRating: number | null;
  status?: FriendshipStatus;
}

/**
 * Pagination metadata
 */
export interface PaginationMeta {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

/**
 * Generic API response wrapper
 */
export interface ApiResponse<T> {
  data: T;
  pagination?: PaginationMeta;
  error?: {
    code: string;
    message: string;
  };
}

export interface IncomingFriendRequestResponse {
  id: number;
  senderId: number;
  senderUsername: string;
  senderAvatarUrl: string | null;
  createdAt: Date;
}

export interface OutgoingFriendRequestResponse {
  id: number;
  receiverId: number;
  receiverUsername: string;
  receiverAvatarUrl: string | null;
  createdAt: Date;
}

export interface PaginatedFriendsResponse {
  data: FriendListItem[];
  pagination: PaginationMeta;
}

export interface PaginatedFriendRequestsResponse {
  incoming: IncomingFriendRequestResponse[];
  outgoing: OutgoingFriendRequestResponse[];
}

export interface SendFriendRequestBody {
  receiverId: number;
}
