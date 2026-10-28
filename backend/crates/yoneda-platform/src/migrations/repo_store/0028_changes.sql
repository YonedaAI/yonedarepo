-- Change requests: a branch proposed for landing on main, with its conversation. At most
-- one open change per branch. Landing the branch's head on main marks it landed in the
-- landing's own transaction (landed_version, landed_commit). A comment may be anchored to
-- a diff line (path, line, side) at a commit, and resolving marks that anchor's comments.
CREATE TABLE changes(
  number INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  branch TEXT NOT NULL,
  base TEXT NOT NULL DEFAULT 'main',
  author TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('open','landed','closed')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  landed_version INTEGER,
  landed_commit TEXT
);
CREATE UNIQUE INDEX changes_one_open ON changes(branch) WHERE status='open';
CREATE INDEX changes_by_status ON changes(status, number);
CREATE INDEX changes_by_landing ON changes(landed_version) WHERE landed_version IS NOT NULL;
CREATE TABLE change_comments(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  change_number INTEGER NOT NULL,
  commit_id TEXT NOT NULL,
  path TEXT,
  line INTEGER,
  side TEXT CHECK (side IN ('old','new')),
  body TEXT NOT NULL,
  principal TEXT NOT NULL,
  at INTEGER NOT NULL,
  resolved_at INTEGER
);
CREATE INDEX change_comments_by_change ON change_comments(change_number, id)
