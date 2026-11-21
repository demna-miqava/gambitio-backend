-- Coordinates trainer: a square name appears and the player clicks that
-- square, as many as they can before the clock runs out. The drill runs in
-- the browser, so a score is the player's own claim: kept as a personal
-- record only (no leaderboard), and refused when nobody could reach it in
-- the time (src/routes/coordinates.ts).
--
-- "mode" is the drill: 'find' (click the named square). A mode where a
-- square lights up and the player names it can be added to the CHECKs.

-- The best score per account, drill, run length and side of the board
CREATE TABLE coordinate_bests (
  "userId" integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  mode varchar(10) NOT NULL CHECK (mode IN ('find')),
  seconds smallint NOT NULL CHECK (seconds IN (30, 60, 120)),
  perspective varchar(5) NOT NULL CHECK (perspective IN ('white', 'black')),
  best smallint NOT NULL CHECK (best >= 0),
  "achievedAt" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("userId", mode, seconds, perspective)
);

-- Recent runs, to show progress; each account keeps only its latest few
-- (trimmed on insert)
CREATE TABLE coordinate_runs (
  id bigserial PRIMARY KEY,
  "userId" integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  mode varchar(10) NOT NULL CHECK (mode IN ('find')),
  seconds smallint NOT NULL CHECK (seconds IN (30, 60, 120)),
  perspective varchar(5) NOT NULL CHECK (perspective IN ('white', 'black')),
  "withPieces" boolean NOT NULL,
  score smallint NOT NULL CHECK (score >= 0),
  misses smallint NOT NULL CHECK (misses >= 0),
  "createdAt" timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX coordinate_runs_user_recent ON coordinate_runs ("userId", id DESC);
