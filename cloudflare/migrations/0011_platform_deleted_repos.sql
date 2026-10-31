-- Repositories in their undo window (repo-deleted.ts): what `GET /repos/deleted` lists and the
-- every-minute sweep reads for purges that are due. Apart from platform_repos, whose readers
-- would each need a filter to keep a deleted repository out. A rebuildable projection of each
-- owner's `deleted_repo:<id>` records. `sent_at` is when the sweep last sent its purge.
CREATE TABLE IF NOT EXISTS platform_deleted_repos(
  id TEXT PRIMARY KEY,
  workspace TEXT NOT NULL,
  name TEXT NOT NULL,
  visibility TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  deleted_at INTEGER NOT NULL,
  purge_at INTEGER NOT NULL,
  sent_at INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS platform_deleted_repos_by_due ON platform_deleted_repos(purge_at);
CREATE INDEX IF NOT EXISTS platform_deleted_repos_by_workspace ON platform_deleted_repos(workspace,deleted_at);
