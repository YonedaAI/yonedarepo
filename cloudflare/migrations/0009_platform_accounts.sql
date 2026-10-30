-- The operators' account index (admin pages): one row per account, written when it is made
-- (password sign-up or a first provider sign-in) and by the backfill for older ones. A
-- rebuildable projection: each account's authority holds its creation time, provider
-- identities, handle and suspension (`suspended_at` here only lists it). `last_seen_at` is a
-- session check's time, kept to the day.
CREATE TABLE IF NOT EXISTS platform_accounts(
  account TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  provider TEXT NOT NULL,
  handle TEXT,
  email_named INTEGER NOT NULL DEFAULT 0,
  suspended_at INTEGER,
  last_seen_at INTEGER
);
CREATE INDEX IF NOT EXISTS platform_accounts_by_created ON platform_accounts(created_at);
-- Every operator action from the admin pages (who, what, on which account or repository).
CREATE TABLE IF NOT EXISTS admin_audit(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  target TEXT NOT NULL,
  detail TEXT
);
CREATE INDEX IF NOT EXISTS admin_audit_by_at ON admin_audit(at);
-- The operators' sign-up notice email (platform-signup-notice.ts): when the last went out and
-- the newest sign-up it covered, so at most one goes out per five minutes and the next names
-- every sign-up since.
CREATE TABLE IF NOT EXISTS admin_notices(
  kind TEXT PRIMARY KEY,
  sent_at INTEGER NOT NULL,
  through INTEGER NOT NULL
);
