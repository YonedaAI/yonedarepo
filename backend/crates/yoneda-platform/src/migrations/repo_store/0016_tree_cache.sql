-- Trees this authority built or verified, by id (a bounded, rebuildable cache), so a
-- commit on a recent head needs no tree round trips to the adapter.
CREATE TABLE tree_cache(
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  data_b64 TEXT NOT NULL
)
