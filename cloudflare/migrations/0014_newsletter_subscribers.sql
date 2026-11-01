-- The Flight log's mailing list (cloudflare/worker/platform-newsletter.ts), double opt-in. Unlike
-- the other tables here this is an authority, not a projection: nothing can rebuild it. `id` is
-- AUTOINCREMENT because an unsubscribe link names it, and a swept row's id must never come back
-- for someone else. `token_hash` is the SHA-256 of the confirmation link's token, kept only while
-- it can be used; `token_at` is when it was issued. `mails` counts the confirmations sent since
-- `mails_since`, for the limit per address.
CREATE TABLE IF NOT EXISTS newsletter_subscribers(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  confirmed_at INTEGER,
  unsubscribed_at INTEGER,
  token_hash TEXT,
  token_at INTEGER NOT NULL,
  mails INTEGER NOT NULL DEFAULT 1,
  mails_since INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS newsletter_token ON newsletter_subscribers(token_hash)
  WHERE token_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS newsletter_pending ON newsletter_subscribers(token_at)
  WHERE confirmed_at IS NULL;
CREATE INDEX IF NOT EXISTS newsletter_list ON newsletter_subscribers(id)
  WHERE confirmed_at IS NOT NULL AND unsubscribed_at IS NULL;
