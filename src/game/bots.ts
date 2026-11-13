/**
 * The computer opponents a finished bot game can be saved against. Mirrors
 * gambitio-frontend/src/features/play-bots/constants/bots.ts (ids, names and
 * ratings must match; the frontend list also has descriptions).
 */
export interface Bot {
  id: string;
  name: string;
  rating: number;
}

export const BOTS: readonly Bot[] = [
  { id: "beginner-bot", name: "Beginner Bot", rating: 300 },
  { id: "casual-bot", name: "Casual Carl", rating: 600 },
  { id: "improving-bot", name: "Improving Ivan", rating: 900 },
  { id: "club-bot", name: "Club Player Clara", rating: 1200 },
  { id: "intermediate-bot", name: "Intermediate Igor", rating: 1500 },
  { id: "advanced-bot", name: "Advanced Alex", rating: 1800 },
  { id: "expert-bot", name: "Expert Elena", rating: 2100 },
  { id: "master-bot", name: "Master Gary", rating: 2400 },
  { id: "grandmaster-bot", name: "Grandmaster Magnus", rating: 2800 },
  { id: "stockfish-bot", name: "Stockfish Supreme", rating: 3500 },
];

export const getBotById = (id: string): Bot | undefined => BOTS.find((bot) => bot.id === id);
