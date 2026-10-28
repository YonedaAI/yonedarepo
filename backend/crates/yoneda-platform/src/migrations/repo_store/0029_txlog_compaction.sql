-- Log compaction: whole segments of old versions move to the object store (`_log/segment-*`
-- and `_log/checkpoint-*` under the repository's prefix), sealed with fingerprints kept
-- here, so the SQL log keeps a bounded tail. Segments are contiguous from version 0 and the
-- newest one's end is the floor. The anchor is the ref state at the floor, where replay of
-- the retained tail starts. Retention is per repository (absent means the defaults).
CREATE TABLE txlog_segments(
  start_version INTEGER PRIMARY KEY,
  end_version INTEGER NOT NULL UNIQUE,
  segment_key TEXT NOT NULL,
  segment_digest TEXT NOT NULL,
  checkpoints_key TEXT NOT NULL,
  checkpoints_digest TEXT NOT NULL,
  last_chain TEXT NOT NULL,
  compacted_at INTEGER NOT NULL
);
CREATE TABLE txlog_anchor(
  id INTEGER PRIMARY KEY CHECK (id = 1),
  version INTEGER NOT NULL,
  checkpoint TEXT NOT NULL,
  refs_digest TEXT NOT NULL
);
CREATE TABLE txlog_retention(
  id INTEGER PRIMARY KEY CHECK (id = 1),
  keep_versions INTEGER NOT NULL,
  keep_ms INTEGER NOT NULL
);
