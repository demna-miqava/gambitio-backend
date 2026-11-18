-- Arena tournaments. A tournament runs for a fixed time; players join when
-- they like, are paired with each other as soon as they are free, and score
-- points for every game (src/game/arena.ts). Most points when the time is up
-- wins. See TOURNAMENTS.md.
--
-- "format" is there for a later Swiss; only 'arena' exists.
CREATE TABLE tournaments (
  id serial PRIMARY KEY,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "createdBy" integer NOT NULL REFERENCES users(id),
  name text NOT NULL,
  format text NOT NULL DEFAULT 'arena',
  "time" integer NOT NULL,
  increment integer NOT NULL DEFAULT 0,
  rated boolean NOT NULL DEFAULT true,
  "startsAt" timestamptz NOT NULL,
  -- startsAt plus the tournament's length: no game is started after it
  "endsAt" timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'scheduled',
  "maxPlayers" integer NOT NULL DEFAULT 100,
  -- Players who joined and haven't withdrawn, kept by join and withdraw so
  -- lists don't count rows
  "playerCount" integer NOT NULL DEFAULT 0,
  "startedAt" timestamptz,
  "finishedAt" timestamptz,
  -- First in the final standings; NULL when no game was played
  "winnerId" integer REFERENCES users(id),
  CONSTRAINT tournaments_format CHECK (format IN ('arena')),
  CONSTRAINT tournaments_status CHECK (status IN ('scheduled', 'running', 'finished', 'cancelled')),
  CONSTRAINT tournaments_window CHECK ("endsAt" > "startsAt"),
  CONSTRAINT tournaments_clock CHECK ("time" > 0 AND increment >= 0),
  CONSTRAINT tournaments_players CHECK ("maxPlayers" >= 2 AND "playerCount" >= 0)
);
-- What is on or coming up: the lobby list, and what the tick has to watch
CREATE INDEX tournaments_open_idx ON tournaments ("startsAt") WHERE status IN ('scheduled', 'running');
CREATE INDEX tournaments_closed_idx ON tournaments ("endsAt" DESC) WHERE status IN ('finished', 'cancelled');
-- One open tournament per creator: the second insert fails here, so two
-- requests at once can't both get through a check made in code
CREATE UNIQUE INDEX tournaments_creator_open_idx ON tournaments ("createdBy")
  WHERE status IN ('scheduled', 'running');

-- A player in a tournament. The pairing queue is the rows whose
-- "waitingSince" is set: one row to lock per player, and who is waiting can
-- never disagree with who is in the tournament.
CREATE TABLE tournament_players (
  "tournamentId" integer NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
  "userId" integer NOT NULL REFERENCES users(id),
  "joinedAt" timestamptz NOT NULL DEFAULT now(),
  -- 'active' is paired; 'paused' keeps its place in the standings but isn't
  -- paired; 'withdrawn' has left (the row stays once they have played, so
  -- their opponents' scores still add up)
  status text NOT NULL DEFAULT 'active',
  score integer NOT NULL DEFAULT 0,
  -- Wins in a row, for the streak bonus
  streak smallint NOT NULL DEFAULT 0,
  games integer NOT NULL DEFAULT 0,
  wins integer NOT NULL DEFAULT 0,
  draws integer NOT NULL DEFAULT 0,
  -- Tiebreak: performance rating over the tournament's games (arena.ts)
  "opponentRatingSum" integer NOT NULL DEFAULT 0,
  performance integer NOT NULL DEFAULT 0,
  -- The points of each game in order, one digit each ("2204"): the score
  -- sheet shown in the standings, without reading the games
  sheet text NOT NULL DEFAULT '',
  -- Games played as white, to balance colours
  whites integer NOT NULL DEFAULT 0,
  -- No immediate rematch while someone else is waiting
  "lastOpponentId" integer,
  "waitingSince" timestamptz,
  PRIMARY KEY ("tournamentId", "userId"),
  CONSTRAINT tournament_players_status CHECK (status IN ('active', 'paused', 'withdrawn'))
);
-- A page of the standings is an index scan, however many players
CREATE INDEX tournament_standings_idx
  ON tournament_players ("tournamentId", score DESC, performance DESC, "userId")
  WHERE status <> 'withdrawn' OR games > 0;
-- The pairing pass reads only who is waiting
CREATE INDEX tournament_waiting_idx ON tournament_players ("tournamentId")
  WHERE "waitingSince" IS NOT NULL;
-- A player's tournaments
CREATE INDEX tournament_players_user_idx ON tournament_players ("userId", "joinedAt" DESC);

-- A tournament game is an ordinary live game that points back at its
-- tournament. There is no pairings table: a pairing is a game.
ALTER TABLE games ADD COLUMN "tournamentId" integer REFERENCES tournaments(id);
CREATE INDEX games_tournament_idx ON games ("tournamentId", id) WHERE "tournamentId" IS NOT NULL;
-- "Is any game of this tournament still being played?", asked before it closes
CREATE INDEX games_tournament_live_idx ON games ("tournamentId")
  WHERE "tournamentId" IS NOT NULL AND status = 'in_progress';
