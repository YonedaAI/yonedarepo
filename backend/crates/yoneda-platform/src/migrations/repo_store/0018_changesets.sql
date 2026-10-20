-- Changeset landing (Scion): a path-disjoint landing appends its changeset to the log and
-- advances the branch's log version without building Git objects. A deterministic
-- projector later builds one Git commit per changeset version.
-- txlog_paths indexes every entry's written paths for one-query independence checks. An
-- entry that moved a ref without path detail (reset, delete) is filed under the empty path.
CREATE TABLE txlog_paths(
  refname TEXT NOT NULL,
  path TEXT NOT NULL,
  version INTEGER NOT NULL,
  PRIMARY KEY(refname,path,version)
);
INSERT OR IGNORE INTO txlog_paths(refname,path,version)
  SELECT t.refname,json_extract(p.value,'$.path'),t.version FROM txlog t,json_each(t.entry,'$.paths') p;
INSERT OR IGNORE INTO txlog_paths(refname,path,version)
  SELECT refname,'',version FROM txlog
  WHERE json_array_length(entry,'$.paths')=0 AND json_extract(entry,'$.kind') NOT IN ('commit','merge');
-- One row per changeset version: the landed commit whose changes it carries, and the Git
-- commit the projector built for the branch at that version (NULL until projected).
CREATE TABLE changesets(
  version INTEGER PRIMARY KEY,
  refname TEXT NOT NULL,
  commit_id TEXT NOT NULL,
  projected TEXT,
  landed_at INTEGER NOT NULL,
  projected_at INTEGER
);
CREATE INDEX changesets_pending ON changesets(refname,projected,version);
-- Queued landings whose paths overlap later work wait for the merge path.
ALTER TABLE land_queue ADD COLUMN slow INTEGER NOT NULL DEFAULT 0;
