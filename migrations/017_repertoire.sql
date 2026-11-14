-- Opening repertoire: lines a player prepared, by the colour they play
-- them with. "moves" is the line in SAN from the standard starting
-- position, space separated, as normalised by the server (chess.js).
--
-- Practice uses a simple Leitner schedule: a line recalled correctly is
-- due again after an interval that grows with its streak; a mistake makes
-- it due at once.

CREATE TABLE repertoire_lines (
  id serial PRIMARY KEY,
  "userId" integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  color player_color NOT NULL,
  name varchar(80) NOT NULL,
  moves text NOT NULL,
  plies smallint NOT NULL,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "updatedAt" timestamptz NOT NULL DEFAULT now(),
  "practiceAttempts" integer NOT NULL DEFAULT 0,
  "practiceCorrect" integer NOT NULL DEFAULT 0,
  streak smallint NOT NULL DEFAULT 0,
  "lastPracticedAt" timestamptz,
  "dueAt" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT repertoire_lines_unique UNIQUE ("userId", color, moves),
  CONSTRAINT repertoire_lines_plies CHECK (plies > 0)
);
