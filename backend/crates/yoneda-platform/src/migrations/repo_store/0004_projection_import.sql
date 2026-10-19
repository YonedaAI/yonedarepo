CREATE INDEX commit_paths_by_new_blob ON commit_paths(new_blob);
CREATE INDEX commit_paths_by_old_blob ON commit_paths(old_blob);
ALTER TABLE commits ADD COLUMN origin TEXT NOT NULL DEFAULT 'platform';
CREATE TABLE ref_projections(
  refname TEXT PRIMARY KEY,
  target_commit TEXT NOT NULL,
  target_version INTEGER NOT NULL,
  projected_commit TEXT,
  projected_version INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL CHECK (status IN ('pending','ok','drift')),
  detail TEXT,
  updated_at INTEGER NOT NULL
)
