CREATE INDEX IF NOT EXISTS runs_by_status ON runs(json_extract(payload,'$.status'));
