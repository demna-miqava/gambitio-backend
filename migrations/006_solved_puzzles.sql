-- Puzzles each user has solved; solved puzzles aren't served again. Failed
-- puzzles aren't recorded, so they come back until solved.
CREATE TABLE IF NOT EXISTS solved_puzzles (
    "userId" integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    "puzzleId" text NOT NULL REFERENCES puzzles(id) ON DELETE CASCADE,
    "solvedAt" timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY ("userId", "puzzleId")
);
