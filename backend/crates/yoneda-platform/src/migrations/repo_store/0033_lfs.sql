-- Git LFS objects. Bytes are in R2 (`platform/v1/<repo>/lfs/<oid>`), uploaded by the client
-- straight to a presigned URL. A row is `pending` from the batch that hands out the upload
-- until the adapter verifies the stored bytes (size and sha256) and marks it `stored`.
-- Pending rows count against the quota (so unverified uploads cannot grow storage past
-- it) and lapse after a day. The quota is per repository (absent means the default).
CREATE TABLE lfs_objects(
  oid TEXT PRIMARY KEY,
  size INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending', 'stored')),
  uploaded_by TEXT NOT NULL,
  reserved_at INTEGER NOT NULL,
  stored_at INTEGER
);
CREATE TABLE lfs_quota(
  id INTEGER PRIMARY KEY CHECK (id = 1),
  bytes INTEGER NOT NULL,
  set_by TEXT NOT NULL,
  set_at INTEGER NOT NULL
)
