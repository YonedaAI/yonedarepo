-- R2 is the store of record for platform-built objects. Artifacts receives a protected
-- ref's new objects in one push per projection: artifacts_at marks the commits it holds,
-- commit_objects lists the object ids of those it does not hold yet, and hidden_ref marks
-- commits pushed to their own hidden ref (only those are released by vacuum).
ALTER TABLE commits ADD COLUMN artifacts_at INTEGER;
ALTER TABLE commits ADD COLUMN hidden_ref INTEGER NOT NULL DEFAULT 1;
UPDATE commits SET artifacts_at=recorded_at WHERE id NOT IN (SELECT commit_id FROM object_projections);
UPDATE commits SET hidden_ref=0 WHERE id IN (SELECT commit_id FROM object_projections);
CREATE TABLE commit_objects(
  commit_id TEXT NOT NULL,
  id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('commit','tree','blob')),
  PRIMARY KEY(commit_id,id)
);
INSERT INTO commit_objects(commit_id,id,kind)
  SELECT commit_id,id,kind FROM staged_objects WHERE commit_id IN (SELECT commit_id FROM object_projections)
