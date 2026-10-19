-- Rebuildable listing of source-platform repositories per workspace. Authority (name,
-- owner, policy) stays in each SourceRepository Durable Object.
CREATE TABLE IF NOT EXISTS platform_repos(
  id TEXT PRIMARY KEY,
  workspace TEXT NOT NULL,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS platform_repos_by_workspace ON platform_repos(workspace, created_at);
