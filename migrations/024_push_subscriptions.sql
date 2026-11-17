-- Web push: one row per browser a user turned notifications on in. The
-- endpoint is the push service's address for that browser, so it is unique;
-- signing in as someone else on the same browser moves the row to them.

CREATE TABLE push_subscriptions (
  id serial PRIMARY KEY,
  "userId" integer NOT NULL REFERENCES users(id),
  endpoint text NOT NULL UNIQUE,
  p256dh text NOT NULL,
  auth text NOT NULL,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT push_subscriptions_sizes CHECK (
    char_length(endpoint) <= 1000 AND char_length(p256dh) <= 200 AND char_length(auth) <= 100
  )
);
CREATE INDEX push_subscriptions_user_idx ON push_subscriptions ("userId", id);
