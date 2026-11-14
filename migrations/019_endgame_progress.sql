-- Endgame practice lab: per-exercise progress. The exercises themselves
-- live in the frontend (they are played in the browser against the
-- engine), so "exerciseId" is just their slug.

CREATE TABLE endgame_progress (
  "userId" integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  "exerciseId" varchar(60) NOT NULL,
  attempts integer NOT NULL DEFAULT 0,
  "completedAt" timestamptz,
  -- Fewest of the player's own moves in a successful attempt
  "bestMoves" smallint,
  "updatedAt" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("userId", "exerciseId")
);
