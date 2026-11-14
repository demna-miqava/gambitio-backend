-- A series can be continued from its page: the player sends the opponent a
-- challenge tied to the series ("seriesId"), and accepting it starts the
-- next game. Series nobody plays on expire (see SERIES_IDLE_EXPIRY_MS in
-- src/game/series.ts): the leader on points wins, or the series is drawn.

ALTER TABLE challenges
  ADD COLUMN "seriesId" integer REFERENCES series(id) ON DELETE CASCADE;
CREATE INDEX challenges_series_idx ON challenges ("seriesId") WHERE "seriesId" IS NOT NULL;

ALTER TABLE series DROP CONSTRAINT series_end_reason;
ALTER TABLE series ADD CONSTRAINT series_end_reason
  CHECK ("endReason" IS NULL OR "endReason" IN ('played_out', 'resignation', 'expired'));
-- The expiry sweep looks at active series only
CREATE INDEX series_active_idx ON series ("createdAt") WHERE status = 'active';
