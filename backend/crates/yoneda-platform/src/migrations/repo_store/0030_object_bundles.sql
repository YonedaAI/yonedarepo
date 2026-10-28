-- Bundles: a large push's verified objects are written to the object store as a few R2
-- objects (`bundles/<sha256>` under the repository's prefix, each a run of frames: kind,
-- id, length, content) instead of one R2 object per Git object. This index locates each
-- object in its bundle. A row is written only after its bundle is durable and before any
-- commit naming the object is recorded. Objects stored one per key have no row.
CREATE TABLE bundled_objects(
  id TEXT PRIMARY KEY,
  bundle TEXT NOT NULL,
  at INTEGER NOT NULL,
  size INTEGER NOT NULL,
  kind TEXT NOT NULL
) WITHOUT ROWID;
