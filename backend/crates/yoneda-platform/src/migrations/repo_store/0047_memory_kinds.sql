-- Any short word is a memory kind now, checked where it arrives (repo_store/memory/kinds.rs)
-- rather than by a fixed list here. SQLite can't drop a CHECK, so the table is rebuilt with the
-- same columns, rows, ids and indexes. memory_anchors, memory_retirements and memory_text
-- refer to a memory by id and stay as they are.
CREATE TABLE memories_rebuilt(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  body TEXT NOT NULL,
  commit_id TEXT NOT NULL,
  author TEXT NOT NULL,
  session_id TEXT,
  supersedes INTEGER,
  draft INTEGER NOT NULL DEFAULT 0,
  recorded_at INTEGER NOT NULL,
  recorded_version INTEGER NOT NULL
);
INSERT INTO memories_rebuilt(id,kind,body,commit_id,author,session_id,supersedes,draft,recorded_at,recorded_version)
  SELECT id,kind,body,commit_id,author,session_id,supersedes,draft,recorded_at,recorded_version FROM memories;
DROP TABLE memories;
ALTER TABLE memories_rebuilt RENAME TO memories;
CREATE INDEX memories_by_supersedes ON memories(supersedes) WHERE supersedes IS NOT NULL;
CREATE INDEX memories_by_session ON memories(session_id, id) WHERE session_id IS NOT NULL
