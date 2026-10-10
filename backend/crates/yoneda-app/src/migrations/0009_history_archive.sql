CREATE TABLE IF NOT EXISTS run_history (run_id TEXT PRIMARY KEY, seq INTEGER NOT NULL, created_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS run_history_by_created ON run_history(created_at DESC,run_id DESC,seq);
INSERT OR IGNORE INTO run_history(run_id,seq,created_at)
SELECT r.id,ev.seq,CAST(json_extract(r.payload,'$.created_at') AS INTEGER) FROM events ev
JOIN runs r ON r.id=json_extract(ev.data,'$.id') WHERE ev.kind='run.created';
INSERT OR IGNORE INTO run_history(run_id,seq,created_at)
SELECT json_extract(e.payload,'$.run_id'),ev.seq,CAST(json_extract(r.payload,'$.created_at') AS INTEGER) FROM events ev JOIN executions e
ON e.id=json_extract(ev.data,'$.execution') JOIN runs r ON r.id=json_extract(e.payload,'$.run_id') WHERE ev.kind='contribution.started';
CREATE TABLE IF NOT EXISTS archive_jobs (id TEXT PRIMARY KEY, payload TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS archive_jobs_by_status ON archive_jobs(json_extract(payload,'$.status'));
CREATE TABLE IF NOT EXISTS archive_index (run_id TEXT PRIMARY KEY, payload TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS archive_index_by_digest ON archive_index(json_extract(payload,'$.digest'));
CREATE INDEX IF NOT EXISTS runs_by_external_status ON runs(json_extract(payload,'$.external'),json_extract(payload,'$.status'));
ALTER TABLE outbox ADD COLUMN created_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE outbox ADD COLUMN payload_pruned INTEGER NOT NULL DEFAULT 0;
UPDATE outbox SET created_at=COALESCE(json_extract(payload,'$.event.at'),(SELECT MAX(at) FROM events),0);
CREATE INDEX IF NOT EXISTS delivered_outbox_age ON outbox(delivered,created_at,payload_pruned);
CREATE TABLE IF NOT EXISTS edge_history (source TEXT NOT NULL,target TEXT NOT NULL,relation TEXT NOT NULL,seq INTEGER NOT NULL,PRIMARY KEY(source,target,relation));
CREATE INDEX IF NOT EXISTS edge_history_by_seq ON edge_history(seq,source,target,relation);
INSERT OR IGNORE INTO edge_history(source,target,relation,seq) SELECT source,target,relation,0 FROM edges;
CREATE INDEX IF NOT EXISTS executions_by_run ON executions(json_extract(payload,'$.run_id'),id);
CREATE INDEX IF NOT EXISTS candidates_by_run ON candidates(json_extract(payload,'$.run_id'),id);
CREATE INDEX IF NOT EXISTS evaluations_by_run ON evaluations(json_extract(payload,'$.run_id'),id);
CREATE INDEX IF NOT EXISTS decisions_by_run ON decisions(json_extract(payload,'$.run_id'),id);
CREATE INDEX IF NOT EXISTS artifacts_by_run ON artifacts(json_extract(payload,'$.run_id'),id);
