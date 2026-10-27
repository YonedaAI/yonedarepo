-- Session records (B8): what produced a commit. The coding CLI and model, a short summary,
-- digests of the prompts and of the declared reads, and an optional pointer to a
-- transcript kept elsewhere (never the transcript itself). Keyed by commit like checks,
-- several per commit, in arrival order.
CREATE TABLE sessions(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  commit_id TEXT NOT NULL,
  cli TEXT NOT NULL,
  model TEXT,
  summary TEXT NOT NULL,
  prompt_digest TEXT,
  transcript_ref TEXT,
  read_set_digest TEXT,
  recorded_by TEXT NOT NULL,
  at INTEGER NOT NULL
);
CREATE INDEX sessions_by_commit ON sessions(commit_id, id)
