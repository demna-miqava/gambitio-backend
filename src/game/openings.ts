import { Chess } from "chess.js";

/**
 * Openings a friend challenge can start from (a mirror match, migration 036,
 * is the usual use: both players get each colour of the same position).
 *
 * A game from an opening starts with the opening's moves already played: they
 * are the first moves of its PGN, and `startPly` on the game row counts them.
 * Everything that reads a game (replays, analysis, review, the opening name)
 * works unchanged, since it is an ordinary game from the initial position.
 * The rules that look at "both players' first moves" (clocks starting, abort,
 * the first-move timeout, takebacks) count from `startPly` instead of 0.
 *
 * Ids are stored on challenges, series and games, so an id must never be
 * reused for different moves. Names and ECO codes are the Lichess opening
 * table's (the frontend's src/features/openings), shortened where long.
 */
export interface Opening {
  id: string;
  eco: string;
  name: string;
  /** The moves played before the players take over, in SAN */
  moves: readonly string[];
}

const OPENING_LIST: readonly Opening[] = [
  // 1.e4 e5
  { id: "italian", eco: "C50", name: "Italian Game", moves: ["e4", "e5", "Nf3", "Nc6", "Bc4"] },
  { id: "ruy-lopez", eco: "C60", name: "Ruy Lopez", moves: ["e4", "e5", "Nf3", "Nc6", "Bb5"] },
  { id: "scotch", eco: "C45", name: "Scotch Game", moves: ["e4", "e5", "Nf3", "Nc6", "d4", "exd4", "Nxd4"] },
  { id: "petrov", eco: "C42", name: "Petrov's Defense", moves: ["e4", "e5", "Nf3", "Nf6"] },
  { id: "vienna", eco: "C25", name: "Vienna Game", moves: ["e4", "e5", "Nc3"] },
  { id: "kings-gambit", eco: "C30", name: "King's Gambit", moves: ["e4", "e5", "f4"] },
  { id: "evans-gambit", eco: "C51", name: "Evans Gambit", moves: ["e4", "e5", "Nf3", "Nc6", "Bc4", "Bc5", "b4"] },
  // 1.e4, other replies
  { id: "sicilian", eco: "B20", name: "Sicilian Defense", moves: ["e4", "c5"] },
  {
    id: "sicilian-najdorf",
    eco: "B90",
    name: "Sicilian Defense: Najdorf Variation",
    moves: ["e4", "c5", "Nf3", "d6", "d4", "cxd4", "Nxd4", "Nf6", "Nc3", "a6"],
  },
  {
    id: "sicilian-dragon",
    eco: "B70",
    name: "Sicilian Defense: Dragon Variation",
    moves: ["e4", "c5", "Nf3", "d6", "d4", "cxd4", "Nxd4", "Nf6", "Nc3", "g6"],
  },
  { id: "french", eco: "C00", name: "French Defense", moves: ["e4", "e6"] },
  { id: "caro-kann", eco: "B10", name: "Caro-Kann Defense", moves: ["e4", "c6"] },
  { id: "scandinavian", eco: "B01", name: "Scandinavian Defense", moves: ["e4", "d5"] },
  { id: "pirc", eco: "B07", name: "Pirc Defense", moves: ["e4", "d6", "d4", "Nf6", "Nc3", "g6"] },
  { id: "alekhine", eco: "B02", name: "Alekhine Defense", moves: ["e4", "Nf6"] },
  // 1.d4 d5
  { id: "queens-gambit", eco: "D06", name: "Queen's Gambit", moves: ["d4", "d5", "c4"] },
  { id: "queens-gambit-declined", eco: "D30", name: "Queen's Gambit Declined", moves: ["d4", "d5", "c4", "e6"] },
  { id: "queens-gambit-accepted", eco: "D20", name: "Queen's Gambit Accepted", moves: ["d4", "d5", "c4", "dxc4"] },
  { id: "slav", eco: "D10", name: "Slav Defense", moves: ["d4", "d5", "c4", "c6"] },
  { id: "london", eco: "D02", name: "London System", moves: ["d4", "d5", "Nf3", "Nf6", "Bf4"] },
  // 1.d4 Nf6 and others
  {
    id: "kings-indian",
    eco: "E70",
    name: "King's Indian Defense",
    moves: ["d4", "Nf6", "c4", "g6", "Nc3", "Bg7", "e4", "d6"],
  },
  { id: "nimzo-indian", eco: "E20", name: "Nimzo-Indian Defense", moves: ["d4", "Nf6", "c4", "e6", "Nc3", "Bb4"] },
  { id: "grunfeld", eco: "D80", name: "Grünfeld Defense", moves: ["d4", "Nf6", "c4", "g6", "Nc3", "d5"] },
  { id: "catalan", eco: "E00", name: "Catalan Opening", moves: ["d4", "Nf6", "c4", "e6", "g3"] },
  { id: "benko-gambit", eco: "A57", name: "Benko Gambit", moves: ["d4", "Nf6", "c4", "c5", "d5", "b5"] },
  { id: "dutch", eco: "A80", name: "Dutch Defense", moves: ["d4", "f5"] },
  // Flank openings
  { id: "english", eco: "A10", name: "English Opening", moves: ["c4"] },
  { id: "reti", eco: "A09", name: "Réti Opening", moves: ["Nf3", "d5", "c4"] },
];

/** The position an opening hands over to the players. */
export interface OpeningPosition {
  /** The game's PGN with the opening played, in the engine's format (appendToPgn) */
  pgn: string;
  fen: string;
  /** Half-moves of the opening: the game's `startPly` */
  ply: number;
}

const positions = new Map<string, OpeningPosition>();
for (const opening of OPENING_LIST) {
  const chess = new Chess();
  // Throws on an illegal move, so a typo in the list fails at startup (and in the tests)
  for (const san of opening.moves) chess.move(san);
  positions.set(opening.id, { pgn: chess.pgn(), fen: chess.fen(), ply: opening.moves.length });
}

const byId = new Map(OPENING_LIST.map((opening) => [opening.id, opening]));

/** Every opening, in the order a picker shows them */
export const OPENINGS = OPENING_LIST;

/** Opening ids, for validating what clients send */
export const OPENING_IDS = OPENING_LIST.map((opening) => opening.id) as [string, ...string[]];

export function findOpening(id: string | null | undefined): Opening | null {
  return id ? (byId.get(id) ?? null) : null;
}

/** The position after an opening's moves; null for an unknown id */
export function openingPosition(id: string): OpeningPosition | null {
  return positions.get(id) ?? null;
}

/** An opening as sent to clients, with the position it starts from */
export function toOpeningResponse(opening: Opening) {
  return {
    id: opening.id,
    eco: opening.eco,
    name: opening.name,
    moves: opening.moves,
    fen: positions.get(opening.id)!.fen,
  };
}

/** The short form attached to challenges, series and games: id and name */
export function openingSummary(id: string | null | undefined): { id: string; eco: string; name: string } | null {
  const opening = findOpening(id);
  return opening && { id: opening.id, eco: opening.eco, name: opening.name };
}
