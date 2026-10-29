-- Rebuildable activity summaries for the signed-in Home: one row per repository, the
-- authority's `repo_activity` answer as JSON. A ref move or session record marks the row
-- touched (touched_at), and the account page re-reads a bounded few touched or old rows
-- from their authorities and every other repository from here. A missing or stale row only
-- leaves the Home behind. Authority stays in each SourceRepository Durable Object.
CREATE TABLE IF NOT EXISTS platform_activity(
  repo TEXT PRIMARY KEY,
  touched_at INTEGER NOT NULL DEFAULT 0,
  refreshed_at INTEGER NOT NULL DEFAULT 0,
  summary TEXT
);
