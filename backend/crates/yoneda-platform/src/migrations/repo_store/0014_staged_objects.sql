-- Objects of small commits the authority accepted before the object store held them.
-- They stay readable here by id until the projector has pushed them and read them back.
CREATE TABLE staged_objects(
  commit_id TEXT NOT NULL,
  id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('commit','tree','blob')),
  data_b64 TEXT NOT NULL,
  PRIMARY KEY(commit_id,id)
);
CREATE INDEX staged_objects_by_id ON staged_objects(id);
-- Accepted commits whose objects still wait for the object store (the object outbox).
CREATE TABLE object_projections(
  commit_id TEXT PRIMARY KEY,
  attempts INTEGER NOT NULL DEFAULT 0,
  detail TEXT,
  recorded_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
)
