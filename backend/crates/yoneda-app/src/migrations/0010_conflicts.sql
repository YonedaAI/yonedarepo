CREATE TABLE IF NOT EXISTS conflicts (
    id TEXT PRIMARY KEY,
    payload TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS conflicts_request_id
    ON conflicts(json_extract(payload, '$.request_id'));
CREATE INDEX IF NOT EXISTS conflicts_candidate_id
    ON conflicts(json_extract(payload, '$.candidate_id'));
CREATE UNIQUE INDEX IF NOT EXISTS conflicts_request ON conflicts(json_extract(payload,'$.request_id'));
CREATE INDEX IF NOT EXISTS conflicts_candidate ON conflicts(json_extract(payload,'$.candidate_id'));
