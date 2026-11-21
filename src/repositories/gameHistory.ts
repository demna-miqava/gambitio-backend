import { TIME_CONTROL_SECONDS } from "../models/common.js";

/**
 * Filters on a player's game history, all from the player's side. The
 * opponent is an id (the service looks the username up first).
 */
export interface GameHistoryFilters {
  result?: "won" | "lost" | "drawn" | undefined;
  timeControl?: "bullet" | "blitz" | "rapid" | undefined;
  color?: "white" | "black" | undefined;
  rated?: boolean | undefined;
  kind?: "online" | "tournament" | "bot" | "table" | undefined;
  opponentId?: number | undefined;
  since?: Date | undefined;
  before?: Date | undefined;
}

export const hasHistoryFilters = (f: GameHistoryFilters) =>
  Object.values(f).some((value) => value !== undefined);

/**
 * The WHERE clause for one side of the history (the player's games as White
 * or as Black), or null when the colour filter leaves that side out.
 * `params` is appended to; $1 must be the player's id. Every column read
 * here is in games_{white,black}_history_idx (migration 044), so a filtered
 * count is an index-only scan of the player's own entries: keep it that way
 * when adding a filter. (The page also reads the list's other columns from
 * the table.)
 */
export function historySideWhere(
  side: "white" | "black",
  filters: GameHistoryFilters,
  params: unknown[]
): string | null {
  if (filters.color && filters.color !== side) return null;
  const own = side === "white" ? `"whiteId"` : `"blackId"`;
  const other = side === "white" ? `"blackId"` : `"whiteId"`;
  const bind = (value: unknown) => {
    params.push(value);
    return `$${params.length}`;
  };
  const where = [`${own} = $1`, `result IS DISTINCT FROM 'aborted'`];
  // A game with the same player on both sides is listed once, as White
  if (side === "black") where.push(`"whiteId" IS DISTINCT FROM $1`);

  if (filters.result === "drawn") where.push(`result = 'draw'`);
  else if (filters.result) {
    const won = side === "white" ? "white_win" : "black_win";
    const lost = side === "white" ? "black_win" : "white_win";
    where.push(`result = '${filters.result === "won" ? won : lost}'`);
  }
  if (filters.timeControl) {
    const [min, max] = TIME_CONTROL_SECONDS[filters.timeControl];
    where.push(`"time" >= ${bind(min)}`);
    if (max !== null) where.push(`"time" < ${bind(max)}`);
  }
  if (filters.rated !== undefined) where.push(`rated = ${bind(filters.rated)}`);
  switch (filters.kind) {
    case "online":
      where.push(`"botId" IS NULL AND NOT "tableGame" AND "tournamentId" IS NULL`);
      break;
    case "tournament":
      where.push(`"tournamentId" IS NOT NULL`);
      break;
    case "bot":
      where.push(`"botId" IS NOT NULL`);
      break;
    case "table":
      where.push(`"tableGame"`);
      break;
  }
  if (filters.opponentId !== undefined) where.push(`${other} = ${bind(filters.opponentId)}`);
  if (filters.since) where.push(`"createdAt" >= ${bind(filters.since)}`);
  if (filters.before) where.push(`"createdAt" < ${bind(filters.before)}`);
  return where.join(" AND ");
}
