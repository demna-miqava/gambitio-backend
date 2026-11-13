-- Friend lists filter on "userOneId" = $1 OR "userTwoId" = $1; 004 only
-- indexed "userTwoId".
CREATE INDEX IF NOT EXISTS friends_user_one_idx ON friends ("userOneId");
