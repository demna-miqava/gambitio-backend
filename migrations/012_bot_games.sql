-- Games against the computer. They are played in the browser and stored
-- once finished (POST /api/games/bot) so they show up in the player's game
-- history and can be reviewed. They are unrated: they never touch ratings,
-- the leaderboard game counters (finishGame never sees them) or stats.
--
-- The bot side has a NULL user id and the bot's name and rating in the
-- username / rating columns. "botId" is the bot's id from src/game/bots.ts.
-- Bot games are untimed, so "time" is NULL for them.

ALTER TABLE games
  ADD COLUMN "botId" varchar(40),
  ADD COLUMN rated boolean NOT NULL DEFAULT true;

ALTER TABLE games ALTER COLUMN "time" DROP NOT NULL;

-- Only bot games may be untimed, and a bot game is always a finished,
-- unrated game with exactly one human player. Queries over in-progress games
-- (active game, live lists, deadline sweeper, matchmaking) rely on this to
-- never see bot games.
ALTER TABLE games
  ADD CONSTRAINT games_time_required CHECK ("time" IS NOT NULL OR "botId" IS NOT NULL),
  ADD CONSTRAINT games_bot_unrated_finished CHECK (
    "botId" IS NULL
    OR (NOT rated AND status = 'finished' AND (("whiteId" IS NULL) <> ("blackId" IS NULL)))
  );
