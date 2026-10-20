-- A projected batch commit's landed blobs reach the object store with it: list them for
-- commits projected before they were, and mark those commits as not yet held there, so the
-- next ref projection pushes the blobs (the commits and trees it already holds are not
-- listed again).
INSERT OR IGNORE INTO commit_objects(commit_id,id,kind)
  SELECT c.projected,json_extract(p.value,'$.new_blob'),'blob'
  FROM changesets c JOIN txlog t ON t.version=c.version,json_each(t.entry,'$.paths') p
  WHERE c.batch IS NOT NULL AND c.projected IS NOT NULL AND json_extract(p.value,'$.new_blob') IS NOT NULL;
UPDATE commits SET artifacts_at=NULL
  WHERE id IN (SELECT projected FROM changesets WHERE batch IS NOT NULL AND projected IS NOT NULL)
