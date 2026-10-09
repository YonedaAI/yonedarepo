CREATE TABLE execution_logs (seq INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT NOT NULL UNIQUE, execution_id TEXT NOT NULL, at INTEGER NOT NULL, data TEXT NOT NULL);
CREATE INDEX execution_logs_by_execution ON execution_logs(execution_id,seq);
