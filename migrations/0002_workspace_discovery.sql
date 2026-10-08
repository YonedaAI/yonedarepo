CREATE INDEX repositories_by_workspace ON repositories(COALESCE(json_extract(payload,'$.workspace'),'_admin'),id);
