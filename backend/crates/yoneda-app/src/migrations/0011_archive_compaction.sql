ALTER TABLE execution_logs ADD COLUMN data_pruned INTEGER NOT NULL DEFAULT 0;
CREATE TABLE IF NOT EXISTS maintenance_checkpoints (id TEXT PRIMARY KEY, payload TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS jobs_by_execution_run ON jobs(json_extract(payload,'$.payload.execution.run_id'),id);
CREATE INDEX IF NOT EXISTS jobs_by_run ON jobs(json_extract(payload,'$.payload.run_id'),id);
CREATE INDEX IF NOT EXISTS jobs_by_candidate_run ON jobs(json_extract(payload,'$.payload.candidate.run_id'),id);
CREATE INDEX IF NOT EXISTS jobs_by_decision ON jobs(json_extract(payload,'$.payload.decision_id'),id);
