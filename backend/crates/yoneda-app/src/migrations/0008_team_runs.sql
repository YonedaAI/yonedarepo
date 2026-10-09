CREATE TABLE IF NOT EXISTS team_tasks (id TEXT PRIMARY KEY, payload TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS team_tasks_run ON team_tasks(json_extract(payload,'$.run_id'));
CREATE TABLE IF NOT EXISTS team_handoffs (id TEXT PRIMARY KEY, payload TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS team_handoffs_run ON team_handoffs(json_extract(payload,'$.run_id'));
