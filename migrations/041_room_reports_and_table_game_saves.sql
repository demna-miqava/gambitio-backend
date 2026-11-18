-- Reports from a study room's chat, saving a table game only once, and the
-- indexes account deletion needs on table_game_requests and
-- study_chat_messages.
--
-- Every statement here touches either a new table or a small one
-- (user_reports, table_game_requests, study_chat_messages); the games table
-- isn't altered.
-- Code from before this migration keeps working with it applied: it never
-- reads the new column or table.

-- A report filed from a study room's chat (src/services/moderationService.ts):
-- the room it happened in, and its chat copied into "chatExcerpt" as for a
-- game. A report is about a game or a room, never both.
ALTER TABLE user_reports
  ADD COLUMN "studyRoomId" integer REFERENCES study_rooms(id) ON DELETE SET NULL,
  ADD CONSTRAINT user_reports_one_context CHECK ("gameId" IS NULL OR "studyRoomId" IS NULL);
-- Deleting a room clears it on its reports
CREATE INDEX user_reports_study_room_idx ON user_reports ("studyRoomId") WHERE "studyRoomId" IS NOT NULL;

-- Table games by the id the browser gave them (POST /api/games/table
-- "clientId"): a save sent again (a retry after a lost answer, a second
-- tab) returns the game stored the first time instead of storing another.
-- Kept in a table of its own so the games table needs no new index. Goes
-- with the game, and with the recorder's account.
CREATE TABLE table_game_saves (
  "recorderId" integer NOT NULL REFERENCES users(id),
  "clientId" text NOT NULL CHECK ("clientId" ~ '^[A-Za-z0-9_-]{8,64}$'),
  "gameId" integer NOT NULL UNIQUE REFERENCES games(id) ON DELETE CASCADE,
  PRIMARY KEY ("recorderId", "clientId")
);

-- Account deletion finds a user's table game requests whatever their
-- status (src/services/userService.ts); the indexes of migration 040 only
-- hold pending ones
CREATE INDEX table_game_requests_friend_all_idx ON table_game_requests ("friendId");
CREATE INDEX table_game_requests_recorder_idx ON table_game_requests ("recorderId");
-- And a user's room chat messages (migration 038), which account deletion
-- removes
CREATE INDEX study_chat_messages_sender_idx ON study_chat_messages ("senderId");
