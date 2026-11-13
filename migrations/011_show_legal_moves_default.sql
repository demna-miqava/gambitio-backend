-- New accounts see legal-move dots by default. Existing rows keep whatever
-- they have; this only changes the column default used on INSERT.
ALTER TABLE user_settings ALTER COLUMN "showLegalMovesEnabled" SET DEFAULT true;
