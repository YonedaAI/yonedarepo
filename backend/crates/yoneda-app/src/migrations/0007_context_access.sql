CREATE TABLE context_access (seq INTEGER PRIMARY KEY AUTOINCREMENT, call_id TEXT NOT NULL UNIQUE, run_id TEXT, execution_id TEXT, epoch INTEGER, grant_id TEXT, session_id TEXT, stage TEXT NOT NULL, tool TEXT NOT NULL, at INTEGER NOT NULL, fingerprint TEXT NOT NULL, data TEXT NOT NULL);
CREATE INDEX context_access_by_run ON context_access(run_id,seq);
CREATE INDEX context_access_by_execution ON context_access(execution_id,epoch,seq);
CREATE INDEX context_access_by_grant ON context_access(grant_id,seq);
CREATE TABLE context_sessions (id TEXT PRIMARY KEY, payload TEXT NOT NULL);
CREATE INDEX context_sessions_by_grant ON context_sessions(json_extract(payload,'$.grant_id'));
CREATE TABLE context_access_metadata (id INTEGER PRIMARY KEY CHECK(id=1), activated_at INTEGER NOT NULL);
CREATE INDEX context_nodes_by_author ON nodes(json_extract(payload,'$.author'),id);
