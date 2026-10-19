CREATE TABLE repairs(
  commit_id TEXT NOT NULL,
  refname TEXT NOT NULL,
  check_name TEXT NOT NULL,
  repair_commit TEXT,
  error TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY(commit_id, refname, check_name)
)
