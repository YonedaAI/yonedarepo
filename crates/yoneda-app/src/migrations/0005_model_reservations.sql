CREATE TABLE IF NOT EXISTS model_reservations (id TEXT PRIMARY KEY, payload TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS model_reservations_run ON model_reservations(json_extract(payload,'$.run_id'));
CREATE INDEX IF NOT EXISTS model_reservations_attempt ON model_reservations(json_extract(payload,'$.job_id'),json_extract(payload,'$.epoch'));
