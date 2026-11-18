-- Casual friend challenges: the challenger can make a game (or a whole
-- series) unrated, so it changes no ratings, leaderboard game counters or
-- stats, like a game with time odds.
--
-- Both columns default to true, so the code from before this migration keeps
-- working with them in place (it never writes them, and every challenge and
-- series it makes stays rated). Run it before deploying the code that uses it.
--
-- A challenge or series with time odds is unrated whatever this says: the
-- game insert only rates games without odds (src/repositories/gameRepository.ts).

ALTER TABLE challenges ADD COLUMN rated boolean NOT NULL DEFAULT true;

-- Every game of a series is rated or none is: the next game takes it from here
ALTER TABLE series ADD COLUMN rated boolean NOT NULL DEFAULT true;
