-- Annotated tags and releases. An annotated tag's ref still names its commit (refs and the
-- log are unchanged), and the tag object itself is kept here, byte for byte, so fetches
-- advertise and send it (with the peeled commit). A release describes one existing tag.
-- Its assets' bytes are in R2 (`release/<repo>/<tag>/<name>`), written by the adapter
-- before the asset row is recorded, each with its size and sha256.
CREATE TABLE annotated_tags(
  refname TEXT PRIMARY KEY,
  tag_id TEXT NOT NULL UNIQUE,
  commit_id TEXT NOT NULL,
  data_b64 TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE releases(
  tag TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  notes TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE release_assets(
  tag TEXT NOT NULL,
  name TEXT NOT NULL,
  size INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  content_type TEXT NOT NULL,
  uploaded_by TEXT NOT NULL,
  uploaded_at INTEGER NOT NULL,
  PRIMARY KEY(tag, name)
)
