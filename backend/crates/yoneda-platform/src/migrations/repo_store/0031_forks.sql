-- Forks. A fork records its parent repository and the parent's log version it copied its
-- refs at. Its commit graph (commits and commit_paths reachable from those refs) is copied
-- with origin 'fork', and its object store spec names the parent's store, so object reads
-- fall back to the parent and nothing is copied. fork_origin keeps the refs as copied (the
-- commits the parent certainly holds), which bound what a change from the fork must carry.
-- A parent lists its live forks and refuses deletion while any is left, so inherited
-- objects outlive every fork that reads them. A change opened from a fork names the fork's
-- repository and branch, mirrored in the parent as forks/<fork>/<branch>.
ALTER TABLE repo_settings ADD COLUMN parent TEXT;
ALTER TABLE repo_settings ADD COLUMN parent_version INTEGER;
CREATE TABLE fork_origin(
  refname TEXT PRIMARY KEY,
  commit_id TEXT NOT NULL
) WITHOUT ROWID;
CREATE TABLE forks(
  repo TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL
) WITHOUT ROWID;
ALTER TABLE changes ADD COLUMN source_repo TEXT;
ALTER TABLE changes ADD COLUMN source_branch TEXT
