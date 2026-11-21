/**
 * Imports the Lichess puzzle database into the puzzles table.
 * Download: https://database.lichess.org/#puzzles (lichess_db_puzzle.csv.zst,
 * decompress with `zstd -d`).
 *
 * Usage: npm run import-puzzles -- ./lichess_db_puzzle.csv [--limit 100000]
 * CSV columns: PuzzleId,FEN,Moves,Rating,RatingDeviation,Popularity,NbPlays,Themes,GameUrl,OpeningTags
 *
 * Lichess stores the position *before* the opponent's last move, and Moves
 * starts with that move. The app expects the solver to move first, so each
 * row is converted: the first move is applied to the FEN and dropped.
 *
 * Afterwards the per-theme puzzle counts (puzzle_theme_counts, migration
 * 031) are counted again; the theme picker reads them. The app caches them
 * for up to an hour.
 */
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import pg from "pg";
import { Chess } from "chess.js";

/** Lichess row -> solver-moves-first puzzle, or null if it doesn't replay. */
export function toSolverFirst(fen: string, uciMoves: string[]) {
  const [opponentMove, ...solution] = uciMoves;
  if (!opponentMove || solution.length === 0) return null;
  try {
    const chess = new Chess(fen);
    chess.move({
      from: opponentMove.slice(0, 2),
      to: opponentMove.slice(2, 4),
      ...(opponentMove[4] ? { promotion: opponentMove[4] } : {}),
    });
    return { fen: chess.fen(), moves: solution.join(" ") };
  } catch {
    return null;
  }
}

const BATCH_SIZE = 1000;

/**
 * Recounts the puzzles per theme (one pass over the table). In one
 * transaction, so the theme picker never sees the table half filled.
 */
export async function refreshThemeCounts(client: pg.Client | pg.PoolClient): Promise<void> {
  await client.query("BEGIN");
  try {
    // A full pass over a few million rows can outlast the app's statement
    // timeout, which may be the role's default (ensureSessionTimeouts)
    await client.query("SET LOCAL statement_timeout = 0");
    await client.query("DELETE FROM puzzle_theme_counts");
    await client.query(
      `INSERT INTO puzzle_theme_counts (theme, count)
       SELECT t, COUNT(*) FROM puzzles, unnest(themes) AS t GROUP BY t`
    );
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  }
}

async function main() {
  const [file, ...rest] = process.argv.slice(2);
  const limitIndex = rest.indexOf("--limit");
  const limit = limitIndex >= 0 ? Number(rest[limitIndex + 1]) : Infinity;
  const connectionString = process.env.POSTGRES_CONNECTION_STRING;
  // "--limit" with no number, or not a whole one, would otherwise import everything
  if (!file || !connectionString || !(limit === Infinity || (Number.isInteger(limit) && limit > 0))) {
    console.error("Usage: npm run import-puzzles -- <lichess_db_puzzle.csv> [--limit N]");
    process.exit(1);
  }

  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    await importFile(client, file, limit);
  } finally {
    await client.end();
  }
}

async function importFile(client: pg.Client, file: string, limit: number) {
  let batch: [string, string, string, number, string[]][] = [];
  let imported = 0;

  const flush = async () => {
    if (batch.length === 0) return;
    const values: unknown[] = [];
    const placeholders = batch.map((row, i) => {
      values.push(...row);
      const b = i * 5;
      return `($${b + 1}, $${b + 2}, $${b + 3}, $${b + 4}, $${b + 5})`;
    });
    await client.query(
      `INSERT INTO puzzles (id, fen, moves, rating, themes) VALUES ${placeholders.join(",")}
       ON CONFLICT (id) DO UPDATE SET fen = EXCLUDED.fen, moves = EXCLUDED.moves,
         rating = EXCLUDED.rating, themes = EXCLUDED.themes`,
      values
    );
    imported += batch.length;
    batch = [];
    process.stdout.write(`\rImported ${imported}`);
  };

  const lines = createInterface({ input: createReadStream(file) });
  for await (const line of lines) {
    if (line.startsWith("PuzzleId") || !line.trim()) continue;
    const [id, fen, moves, rating, , , , themes] = line.split(",");
    if (!id || !fen || !moves || !rating) continue;
    const puzzle = toSolverFirst(fen, moves.split(" "));
    if (!puzzle) continue;
    batch.push([id, puzzle.fen, puzzle.moves, Number(rating), themes ? themes.split(" ") : []]);
    if (batch.length >= BATCH_SIZE) await flush();
    if (imported + batch.length >= limit) break;
  }
  await flush();
  console.log(`\nDone: ${imported} puzzles. Counting themes...`);
  await refreshThemeCounts(client);
  console.log("Theme counts updated");
}

if (process.argv[1]?.endsWith("import-lichess-puzzles.ts")) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
