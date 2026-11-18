-- Conversion drills: positions from a player's own games where they were
-- clearly winning and did not win, replayed in the browser against the
-- engine at full strength (src/game/conversion.ts).
--
-- The browser finds the positions: it evaluates the player's unscanned games
-- with Stockfish and reports, per game, the position it picked, or none.
-- The server checks the position against the game (the player's own, not
-- won by them, the player to move) and computes it from the moves itself;
-- only the evaluation is the browser's word.
--
-- A drill is reviewed with spaced repetition, like repertoire lines: a
-- converted drill comes back after a growing interval, a failed one is due
-- again at once.

CREATE TABLE conversion_drills (
  id serial PRIMARY KEY,
  "userId" integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  "gameId" integer NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  -- Half-moves of the game before the position; the player is to move
  ply smallint NOT NULL CHECK (ply >= 0),
  fen text NOT NULL,
  color text NOT NULL CHECK (color IN ('white', 'black')),
  -- The evaluation when it was found, from the player's side: centipawns,
  -- or moves to a mate they deliver
  "evalCp" integer,
  "evalMate" smallint,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  attempts integer NOT NULL DEFAULT 0,
  successes integer NOT NULL DEFAULT 0,
  -- Successful attempts in a row; sets the next interval
  streak smallint NOT NULL DEFAULT 0,
  "lastAttemptAt" timestamptz,
  "dueAt" timestamptz NOT NULL DEFAULT now(),
  -- Fewest of the player's own moves in a successful attempt
  "bestMoves" smallint,
  CONSTRAINT conversion_drills_eval CHECK (("evalCp" IS NULL) <> ("evalMate" IS NULL)),
  CONSTRAINT conversion_drills_one_per_game UNIQUE ("userId", "gameId")
);
CREATE INDEX conversion_drills_due_idx ON conversion_drills ("userId", "dueAt");

-- Games a player's browser has looked at, with or without finding a drill,
-- so they are not scanned again
CREATE TABLE conversion_scans (
  "userId" integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  "gameId" integer NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  "scannedAt" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("userId", "gameId")
);
