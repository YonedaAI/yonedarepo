CREATE TABLE check_runs(
  id TEXT PRIMARY KEY,
  commit_id TEXT NOT NULL,
  name TEXT NOT NULL,
  policy_digest TEXT NOT NULL,
  runner TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued','running','passed','failed','errored')),
  epoch INTEGER NOT NULL DEFAULT 0,
  lease_until INTEGER,
  requested_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  finished_at INTEGER,
  result TEXT
);
CREATE UNIQUE INDEX check_runs_live ON check_runs(commit_id, name, policy_digest) WHERE status <> 'errored';
CREATE TABLE policy_history(
  digest TEXT NOT NULL,
  policy TEXT NOT NULL,
  set_by TEXT NOT NULL,
  set_at INTEGER NOT NULL,
  PRIMARY KEY(set_at, digest)
)
