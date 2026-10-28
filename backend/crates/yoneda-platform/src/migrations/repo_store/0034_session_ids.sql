-- The coding session a record belongs to: a stable id the agent's CLI gives one session
-- (`<cli>:<native id>`, e.g. `opencode:ses_…`), so its reads, pushes and records tie
-- together across commits. Nullable: records from before this, and clients that send none.
-- The listing newest first scans the primary key, and this index serves one session's records.
ALTER TABLE sessions ADD COLUMN session_id TEXT;
CREATE INDEX sessions_by_session ON sessions(session_id, id)
