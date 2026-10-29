-- Quarantined content (repo_store/quarantine.rs): a blob, or a session record's text, the
-- owner withholds without rewriting any id. A record is never deleted: it keeps the
-- target, why, who and when through purge (bytes deleted) or release (served again). A
-- purge is leased like the LFS sweep (`epoch` fences a finisher whose lease ran out).
CREATE TABLE quarantine(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  target_kind TEXT NOT NULL,
  target_id TEXT NOT NULL,
  path TEXT,
  state TEXT NOT NULL,
  reason TEXT NOT NULL,
  actor TEXT NOT NULL,
  at INTEGER NOT NULL,
  purge_after INTEGER NOT NULL,
  epoch INTEGER NOT NULL DEFAULT 0,
  lease_until INTEGER,
  purged_at INTEGER,
  purged_by TEXT,
  released_at INTEGER,
  released_by TEXT
);
CREATE UNIQUE INDEX quarantine_live ON quarantine(target_kind, target_id) WHERE state <> 'released';
CREATE INDEX quarantine_due ON quarantine(state, purge_after)
