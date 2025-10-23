import type { UserSkill } from "../models/User.js";

export function getRatingsBySkill(skill: UserSkill): number {
  const ratingMap: Record<UserSkill, number> = {
    new: 200,
    beginner: 400,
    intermediate: 1000,
    advanced: 1400,
  };
  return ratingMap[skill];
}
