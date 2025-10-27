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

export interface FriendSuggestion {
  id: number;
  username: string;
  avatarUrl: string | null;
  friendsSince: Date;
  blitzRating: number;
  bulletRating: number;
  rapidRating: number;
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
  data: FriendSuggestion[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}

export interface PaginatedFriendRequestsResponse {
  incoming: IncomingFriendRequestResponse[];
  outgoing: OutgoingFriendRequestResponse[];
}

export interface SendFriendRequestBody {
  receiverId: number;
}
