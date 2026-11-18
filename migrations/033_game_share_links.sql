-- Share links. A player of a finished game can make a link to it that needs
-- no account: /share/<shareToken> on the site, served by
-- GET /api/shared-games/:token. The token is random (src/utils/shareToken.ts),
-- not the game's id: ids count up, so a public page by id would hand the
-- whole games table to anyone who counts. NULL until someone shares the game,
-- and again after a player turns the link off.
ALTER TABLE games ADD COLUMN "shareToken" text;

-- The lookup behind the public page, over shared games only
CREATE UNIQUE INDEX games_share_token_idx ON games ("shareToken") WHERE "shareToken" IS NOT NULL;
