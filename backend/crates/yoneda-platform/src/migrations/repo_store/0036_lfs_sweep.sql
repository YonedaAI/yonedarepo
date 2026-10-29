-- LFS bytes no row references any more (a reservation that lapsed, an upload that failed
-- verification): an outbox the platform's LFS sweep job empties. A claim leases an orphan
-- (`epoch` fences a finisher whose lease ran out). While a lease runs, its oid is neither
-- reserved nor stored, so the bytes a sweep deletes are never an object's. `lfs_sweep`
-- holds when the sweep job is next due (one row, absent when nothing waits).
CREATE TABLE lfs_orphans(
  oid TEXT PRIMARY KEY,
  queued_at INTEGER NOT NULL,
  epoch INTEGER NOT NULL DEFAULT 0,
  claimed_at INTEGER,
  lease_until INTEGER
);
CREATE TABLE lfs_sweep(
  id INTEGER PRIMARY KEY CHECK (id = 1),
  due_at INTEGER NOT NULL
)
