-- Team ids: a repository grants a role to one team (`team:<org>/<team>#<id>`), never to a
-- later team that reuses its name. Ids come from the org's counter (record team_seq) and
-- are never reused. Existing teams take their row ids, and the counter starts after them.
ALTER TABLE org_teams ADD COLUMN id INTEGER;
UPDATE org_teams SET id=rowid;
INSERT INTO workspace_records(id,payload)
  SELECT 'team_seq', json_object('last', MAX(rowid)) FROM org_teams HAVING COUNT(*)>0
