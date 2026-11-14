import { AppError } from "./AppError.js";

/**
 * Base error class for all friend-related errors
 */
export class FriendError extends AppError {
  constructor(message: string, code: string, statusCode: number) {
    super(message, code, statusCode);
  }
}

/**
 * Thrown when a friend or friendship is not found
 */
export class FriendNotFoundError extends FriendError {
  constructor(message: string = 'Friend not found') {
    super(message, 'FRIEND_NOT_FOUND', 404);
  }
}

/**
 * Thrown when attempting to create a friendship that already exists
 */
export class FriendshipExistsError extends FriendError {
  constructor(message: string = 'Friendship already exists') {
    super(message, 'FRIENDSHIP_EXISTS', 400);
  }
}

/**
 * Thrown when attempting to send a friend request that already exists
 */
export class FriendRequestExistsError extends FriendError {
  constructor(message: string = 'Friend request already exists') {
    super(message, 'FRIEND_REQUEST_EXISTS', 400);
  }
}

/**
 * Thrown when a friend request is not found
 */
export class FriendRequestNotFoundError extends FriendError {
  constructor(message: string = 'Friend request not found') {
    super(message, 'FRIEND_REQUEST_NOT_FOUND', 404);
  }
}

/**
 * Thrown when a user attempts to perform an unauthorized friend action
 */
export class UnauthorizedFriendActionError extends FriendError {
  constructor(message: string = 'Unauthorized to perform this friend action') {
    super(message, 'UNAUTHORIZED_FRIEND_ACTION', 403);
  }
}

/**
 * Thrown when a user attempts to send a friend request to themselves
 */
export class SelfFriendRequestError extends FriendError {
  constructor(message: string = 'Cannot send friend request to yourself') {
    super(message, 'SELF_FRIEND_REQUEST', 400);
  }
}

/**
 * Thrown when a user is not found in the context of friend operations
 */
export class UserNotFoundError extends FriendError {
  constructor(message: string = 'User not found') {
    super(message, 'USER_NOT_FOUND', 404);
  }
}
