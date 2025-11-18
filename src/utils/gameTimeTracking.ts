import { createClient } from "redis";

type RedisClient = ReturnType<typeof createClient>;

export interface GameTimeState {
  whiteTimeLeft: number; // in milliseconds
  blackTimeLeft: number; // in milliseconds
  activePlayer: "white" | "black";
  lastMoveAt: number; // timestamp in milliseconds
}

/**
 * Initialize game time tracking in Redis when a game starts
 */
export async function initializeGameTime(
  redis: RedisClient,
  gameId: number,
  initialTime: number, // in seconds
  activePlayer: "white" | "black" = "white"
): Promise<void> {
  const timeState: GameTimeState = {
    whiteTimeLeft: initialTime * 1000, // convert to milliseconds
    blackTimeLeft: initialTime * 1000,
    activePlayer,
    lastMoveAt: Date.now(),
  };

  await redis.set(`game:${gameId}:time`, JSON.stringify(timeState));
}

/**
 * Update time when a move is made
 */
export async function updateGameTime(
  redis: RedisClient,
  gameId: number,
  increment: number | null, // in seconds
  moveNumber: number // to check if this is the first move
): Promise<GameTimeState | null> {
  const timeDataStr = await redis.get(`game:${gameId}:time`);
  if (!timeDataStr) return null;

  const timeState: GameTimeState = JSON.parse(timeDataStr);
  const now = Date.now();
  const timeSpent = now - timeState.lastMoveAt;

  // Increment is only added after move 1 (so starting from move 2)
  const incrementMs = (increment ?? 0) * 1000;

  // Determine who made the move based on move number
  // Odd moves (1, 3, 5...) = White, Even moves (2, 4, 6...) = Black
  const playerWhoMoved: "white" | "black" =
    moveNumber % 2 === 1 ? "white" : "black";

  // Update the time for the player who just moved
  if (playerWhoMoved === "white") {
    const oldTime = timeState.whiteTimeLeft;
    timeState.whiteTimeLeft = Math.max(
      0,
      timeState.whiteTimeLeft - timeSpent + incrementMs
    );

    timeState.activePlayer = "black"; // Switch to opponent
  } else {
    const oldTime = timeState.blackTimeLeft;
    timeState.blackTimeLeft = Math.max(
      0,
      timeState.blackTimeLeft - timeSpent + incrementMs
    );

    timeState.activePlayer = "white"; // Switch to opponent
  }

  timeState.lastMoveAt = now;

  // Save updated state
  await redis.set(`game:${gameId}:time`, JSON.stringify(timeState));

  return timeState;
}

/**
 * Get current time state for a game
 */
export async function getGameTime(
  redis: RedisClient,
  gameId: number
): Promise<GameTimeState | null> {
  const timeDataStr = await redis.get(`game:${gameId}:time`);
  if (!timeDataStr) return null;

  return JSON.parse(timeDataStr);
}

/**
 * Get current time left for both players (accounting for time elapsed since last move)
 */
export async function getCurrentTimeLeft(
  redis: RedisClient,
  gameId: number
): Promise<{ whiteTimeLeft: number; blackTimeLeft: number } | null> {
  const timeDataStr = await redis.get(`game:${gameId}:time`);
  if (!timeDataStr) return null;

  const timeState: GameTimeState = JSON.parse(timeDataStr);
  const now = Date.now();
  const timeElapsed = now - timeState.lastMoveAt;

  let whiteTimeLeft = timeState.whiteTimeLeft;
  let blackTimeLeft = timeState.blackTimeLeft;

  // Subtract elapsed time from active player
  if (timeState.activePlayer === "white") {
    whiteTimeLeft = Math.max(0, whiteTimeLeft - timeElapsed);
  } else {
    blackTimeLeft = Math.max(0, blackTimeLeft - timeElapsed);
  }

  return { whiteTimeLeft, blackTimeLeft };
}

/**
 * Delete game time tracking data when game ends
 */
export async function deleteGameTime(
  redis: RedisClient,
  gameId: number
): Promise<void> {
  await redis.del(`game:${gameId}:time`);
}
