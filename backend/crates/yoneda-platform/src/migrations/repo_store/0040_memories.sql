-- Repository memories: durable, append-only notes (a decision, constraint, gotcha or
-- how-to) that agents and people leave with the code. Each is written against a commit
-- and anchored to paths or symbols there (the anchored file's blob and the symbol's node
-- digest, resolved by the adapter), so it reads as stale once that code changes on main.
-- Retiring and superseding append rows of their own: nothing here is updated or deleted.
-- A draft (an agent's end-of-session summary) is never delivered until a person
-- publishes it by superseding it.
CREATE TABLE memories(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL CHECK (kind IN ('decision','constraint','gotcha','howto')),
  body TEXT NOT NULL,
  commit_id TEXT NOT NULL,
  author TEXT NOT NULL,
  session_id TEXT,
  supersedes INTEGER,
  draft INTEGER NOT NULL DEFAULT 0,
  recorded_at INTEGER NOT NULL,
  recorded_version INTEGER NOT NULL
);
CREATE INDEX memories_by_supersedes ON memories(supersedes) WHERE supersedes IS NOT NULL;
CREATE INDEX memories_by_session ON memories(session_id, id) WHERE session_id IS NOT NULL;
-- `symbol_path` is empty for a whole file, and a `path` ending in '/' anchors a directory.
CREATE TABLE memory_anchors(
  memory_id INTEGER NOT NULL,
  path TEXT NOT NULL,
  symbol_path TEXT NOT NULL,
  blob TEXT,
  node_digest TEXT,
  PRIMARY KEY(memory_id, path, symbol_path)
);
CREATE INDEX memory_anchors_by_path ON memory_anchors(path, memory_id);
CREATE TABLE memory_retirements(
  memory_id INTEGER PRIMARY KEY,
  reason TEXT,
  principal TEXT NOT NULL,
  at INTEGER NOT NULL,
  recorded_version INTEGER NOT NULL
);
-- Full-text candidates for a query (rowid = memories.id), ranked in Rust.
CREATE VIRTUAL TABLE memory_text USING fts5(body, tokenize='unicode61');
-- What context was shown to a coding session and when (session start, a file read, a
-- prompt): the session page's "context delivered", and the per-session dedupe.
CREATE TABLE context_deliveries(
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  trigger TEXT NOT NULL CHECK (trigger IN ('start','read','prompt')),
  subject TEXT,
  items TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  principal TEXT NOT NULL,
  at INTEGER NOT NULL
);
CREATE INDEX context_deliveries_by_session ON context_deliveries(session_id, principal, seq)
