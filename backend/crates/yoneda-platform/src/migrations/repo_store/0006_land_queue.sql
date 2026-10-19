CREATE TABLE land_queue(
  ticket INTEGER PRIMARY KEY AUTOINCREMENT,
  refname TEXT NOT NULL,
  commit_id TEXT NOT NULL,
  principal TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','landed','failed')),
  result TEXT,
  requested_at INTEGER NOT NULL,
  finished_at INTEGER
);
CREATE INDEX land_queue_pending ON land_queue(refname, status, ticket);
CREATE TABLE land_leases(
  refname TEXT PRIMARY KEY,
  epoch INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
)
