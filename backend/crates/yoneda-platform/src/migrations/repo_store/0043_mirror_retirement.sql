-- Retiring the repository's Artifacts mirror once a purge deleted a blob's bytes
-- (repo_store/quarantine/mirror.rs): Artifacts deletes only whole repositories, so the
-- mirror's history is copied into the store of record and the mirror deleted. One row:
-- the mirror being retired and the store that replaces it, the step reached, and a lease
-- fenced by `epoch` like the purge's. `mirror_copied` lists commits whose whole history is
-- in the store of record (the copy's `have`s). A quarantine record shows the retirement
-- its purge started (`mirror`: retiring, then retired).
CREATE TABLE mirror_retirement(
  id INTEGER PRIMARY KEY CHECK (id = 1),
  mirror TEXT NOT NULL,
  replacement TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('copying', 'switched', 'retired')),
  epoch INTEGER NOT NULL DEFAULT 0,
  lease_until INTEGER,
  detail TEXT,
  requested_at INTEGER NOT NULL,
  switched_at INTEGER,
  retired_at INTEGER
);
CREATE TABLE mirror_copied(
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  commit_id TEXT NOT NULL UNIQUE
);
ALTER TABLE quarantine ADD COLUMN mirror TEXT
