-- Table mode: two people at a real board use one phone as the clock and the
-- move recorder (src/game/tableGame.ts, src/services/tableGameService.ts).
-- Like a bot game it is played in the browser and stored once finished
-- (POST /api/games/table), replayed and checked by the server.
--
-- A table game is always finished and unrated, and is never a bot, series
-- or tournament game: it shows in its players' history and in review, and
-- every other reader of the games table leaves it out ("tableGame"), so it
-- touches no ratings, stats, head-to-head, leaderboard counters, chat,
-- rematches, share links or repertoire checks.
--
-- The other player is a guest (a name in the username column, no user id)
-- or a friend. A friend's id goes on the game only once they confirm it
-- (table_game_requests); until then, or if they decline, their side is just
-- their name, so the game is in nobody's history but the recorder's.
ALTER TABLE games ADD COLUMN "tableGame" boolean NOT NULL DEFAULT false;
ALTER TABLE games ADD CONSTRAINT games_table_unrated_finished CHECK (
  NOT "tableGame"
  OR (NOT rated AND status = 'finished' AND "botId" IS NULL AND "seriesId" IS NULL AND "tournamentId" IS NULL)
);

CREATE TABLE table_game_requests (
  "gameId" integer PRIMARY KEY REFERENCES games(id) ON DELETE CASCADE,
  "recorderId" integer NOT NULL REFERENCES users(id),
  "friendId" integer NOT NULL REFERENCES users(id),
  -- The friend's side of the board
  color text NOT NULL CHECK (color IN ('white', 'black')),
  -- A declined request is kept so the friend's name on the game can be
  -- replaced if they delete their account; it is never shown again
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'declined')),
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  CHECK ("recorderId" <> "friendId")
);
-- The friend's inbox
CREATE INDEX table_game_requests_friend_idx ON table_game_requests ("friendId", "createdAt")
  WHERE status = 'pending';
-- The per-pair limit on pending requests
CREATE INDEX table_game_requests_pair_idx ON table_game_requests ("recorderId", "friendId")
  WHERE status = 'pending';
