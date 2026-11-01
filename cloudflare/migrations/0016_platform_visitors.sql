-- The Visitors tab's two needs (site-visitors.ts, platform-visitor-salt.ts). A day's random salt,
-- kept only while that day's pings need it: once it's deleted a past hash can't be rebuilt. And
-- where an account's first page came from, so a campaign can be followed to a repository.
CREATE TABLE IF NOT EXISTS platform_visitor_salts(
  day TEXT PRIMARY KEY,
  salt TEXT NOT NULL
);
ALTER TABLE platform_accounts ADD COLUMN signup_ref TEXT;
ALTER TABLE platform_accounts ADD COLUMN signup_utm_source TEXT;
ALTER TABLE platform_accounts ADD COLUMN signup_utm_medium TEXT;
ALTER TABLE platform_accounts ADD COLUMN signup_utm_campaign TEXT;
