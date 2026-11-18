-- Validates the CHECK constraints migrations 036 and 040 added to the games
-- table as NOT VALID. Adding a constraint takes the table's exclusive lock,
-- and checking every existing row under it would hold up every move and
-- every read of a game for as long as the scan takes. VALIDATE CONSTRAINT
-- does that scan under a lock that lets games be read and written
-- meanwhile. It is in its own file because each migration runs in one
-- transaction (scripts/migrate.ts), and the lock from adding the constraint
-- is held to the end of that transaction.
--
-- On a database where they were added already validated, this does nothing.
ALTER TABLE games VALIDATE CONSTRAINT games_start_ply;
ALTER TABLE games VALIDATE CONSTRAINT games_table_unrated_finished;
