-- Game chat is now deleted an hour after its game ends (counted from
-- games."endedAt"), not weeks after each message was written, so the
-- retention sweep no longer looks messages up by "createdAt".
DROP INDEX IF EXISTS game_chat_messages_created_idx;
