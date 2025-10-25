/**
 * Common types used across the application
 */

export type TimeControl = "bullet" | "blitz" | "rapid";

/**
 * Helper to determine time control type from time in seconds
 */
export function getTimeControl(timeInSeconds: number): TimeControl {
  if (timeInSeconds < 180) return "bullet"; // < 3 minutes
  if (timeInSeconds < 600) return "blitz"; // < 10 minutes
  return "rapid";
}
