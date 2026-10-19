CREATE TABLE bisects(
  id TEXT PRIMARY KEY,
  refname TEXT NOT NULL,
  check_name TEXT NOT NULL,
  candidates TEXT NOT NULL,
  lo INTEGER NOT NULL,
  hi INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running','found','failed')),
  result TEXT,
  requested_by TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE pins(
  commit_id TEXT PRIMARY KEY,
  reason TEXT NOT NULL,
  pinned_by TEXT NOT NULL,
  pinned_at INTEGER NOT NULL
);
ALTER TABLE commits ADD COLUMN hidden_ref_deleted_at INTEGER
