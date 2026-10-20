CREATE TABLE commit_symbols(
  commit_id TEXT NOT NULL,
  path TEXT NOT NULL,
  symbols TEXT NOT NULL,
  derived_at INTEGER NOT NULL,
  PRIMARY KEY(commit_id,path)
)
