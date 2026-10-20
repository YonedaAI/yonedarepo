-- A commit shard: records of commits built by stateless compute, their changesets and
-- derived classes/symbols, and staged objects until R2 holds them. No refs live here.
CREATE TABLE commits(
  id TEXT PRIMARY KEY,
  tree TEXT NOT NULL,
  parents TEXT NOT NULL,
  generation INTEGER NOT NULL,
  base_version INTEGER NOT NULL,
  principal TEXT NOT NULL,
  message TEXT NOT NULL,
  read_set TEXT NOT NULL,
  recorded_at INTEGER NOT NULL
);
CREATE TABLE commit_paths(
  commit_id TEXT NOT NULL,
  path TEXT NOT NULL,
  op TEXT NOT NULL,
  old_blob TEXT,
  new_blob TEXT,
  PRIMARY KEY(commit_id,path)
);
CREATE TABLE commit_classes(
  commit_id TEXT PRIMARY KEY,
  overall TEXT NOT NULL,
  files TEXT NOT NULL
);
CREATE TABLE commit_symbols(
  commit_id TEXT NOT NULL,
  path TEXT NOT NULL,
  symbols TEXT NOT NULL,
  PRIMARY KEY(commit_id,path)
);
CREATE TABLE staged_objects(
  commit_id TEXT NOT NULL,
  id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('commit','tree','blob')),
  data_b64 TEXT NOT NULL,
  PRIMARY KEY(commit_id,id)
);
CREATE INDEX staged_objects_by_id ON staged_objects(id);
CREATE TABLE commit_objects(
  commit_id TEXT NOT NULL,
  id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('commit','tree','blob')),
  PRIMARY KEY(commit_id,id)
);
CREATE TABLE object_projections(
  commit_id TEXT PRIMARY KEY,
  attempts INTEGER NOT NULL DEFAULT 0,
  detail TEXT,
  recorded_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE object_outbox_dispatch(
  id INTEGER PRIMARY KEY CHECK (id = 1),
  dispatched_at INTEGER NOT NULL
)
